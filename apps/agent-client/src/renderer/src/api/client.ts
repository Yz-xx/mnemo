import type {
  AuthSession,
  AuthUser,
  Conversation,
  ConversationSummary,
  KnowledgeBase,
  KnowledgeBaseView,
  KnowledgeDocument,
} from '../types';
import type { KnowledgeUploadOptions } from './knowledgeUpload';
import type {
  ChatErrorCode,
  ChatStreamEvent,
  ChatStreamFrame,
  KnowledgeCitation,
} from '@mnemo/reusable';
import type { BaseUrlLike, HttpClient } from '@mnemo/shared';
import { encryptPassword, isNotFound, isUnauthorized, parseSSEStream } from '@mnemo/reusable';
import { createHttpClient } from '@mnemo/shared';
import { uploadKnowledgeFile } from './knowledgeUpload';

// 渲染进程只有本模块依赖 @mnemo/*（见 desktop-design 第 2 章）：其余模块要用共享能力
// 也经此处转发，避免第二个模块直接引包，让产物里多带无关代码

export { SESSION_EXPIRED_MESSAGE } from '@mnemo/reusable';
export { toErrorMessage } from '@mnemo/shared';

// 共享能力统一从本模块转发，调用方不直接引 @mnemo/*
export type { ChatErrorCode, ChatStreamEvent, ChatStreamFrame, KnowledgeCitation };
export { CHAT_ERROR_CODE } from '@mnemo/reusable';
export { isUnauthorized, isNotFound };

export interface SendChatPayload {
  conversationId?: string;
  message: string;
  /** 本轮随提问一起交给智能体读取的附件 ID；服务端会校验其归属当前用户 */
  fileIds?: string[];
  /** 客户端生成的轮次 ID：既作本轮的幂等键，也是断线后重连续传的定位锚 */
  roundId?: string;
  /** 新会话首轮绑定的知识库：限定检索范围；不传即不限库（沿旧行为） */
  knowledgeBaseId?: string;
}

/** 服务端健康信息，用于界面展示当前模型与知识库状态 */
export interface HealthInfo {
  status: string;
  provider: string;
  model: string;
  knowledgeEnabled: boolean;
}

/** 服务端登记完成的上传文件：id 用于随消息引用，其余字段用于界面展示 */
export interface UploadedFileInfo {
  id: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  createdAt: string;
}

/** 文档预览：文本类返回解析后全文，二进制类返回原始文件字节 */
export type DocumentPreview =
  { kind: 'text'; content: string; document: KnowledgeDocument } | { kind: 'file'; blob: Blob };

/**
 * 后端智能体服务的 HTTP 客户端：薄外壳，构造时基于 createHttpClient 创建实例，
 * 业务方法转发到通用客户端。
 *
 * 地址与令牌接受裸值或取值器：取值器形态下每次请求才求值，
 * 因此「保存设置切换地址」「登录/登出」都无需重建实例——
 * 全局会话在 api/session.ts 里长期持有一个取值器版实例；
 * 仅「保存前先探测草稿地址」这类临时目标才 new 出新实例（裸值即可）。
 */
export class AgentApi {
  private readonly api: HttpClient;
  /** XHR 上传要自己拼完整地址：通用客户端不外露 baseURL，构造时留一份取值器 */
  private readonly baseUrl: BaseUrlLike;
  private readonly getToken: () => string;

  constructor(baseUrl: BaseUrlLike, token: string | (() => string) = '') {
    this.baseUrl = baseUrl;
    this.getToken = () => (typeof token === 'function' ? token() : token);
    this.api = createHttpClient({
      baseURL: baseUrl,
      getToken: this.getToken,
    });
  }

  health(): Promise<HealthInfo> {
    return this.api.get<HealthInfo>('/api/health');
  }

  async register(username: string, password: string): Promise<AuthSession> {
    // 口令先经服务端公钥加密再提交（见 ADR 0004），明文不上网
    const encryptedPassword = await encryptPassword(this.api, password);
    const body = { username, password: encryptedPassword };
    return this.api.post<AuthSession>('/api/auth/register', body);
  }

  async login(username: string, password: string): Promise<AuthSession> {
    const encryptedPassword = await encryptPassword(this.api, password);
    const body = { username, password: encryptedPassword };
    return this.api.post<AuthSession>('/api/auth/login', body);
  }

  logout(): Promise<void> {
    return this.api.post<void>('/api/auth/logout');
  }

  /** 上传附件：由服务端按文件头复核类型并存档，返回的 id 用于随消息引用 */
  uploadFile(file: { name: string; bytes: Uint8Array }): Promise<UploadedFileInfo> {
    const form = new FormData();
    // 先拷出精确长度的 ArrayBuffer：传入的 Uint8Array 可能只是大缓冲上的一个视图，
    // 直接交给 Blob 会带上视图之外的字节（类型上也不满足 BlobPart 对 ArrayBuffer 的要求）
    const buffer = file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength,
    ) as ArrayBuffer;
    // 第三参显式给文件名：FormData 取不到 Blob 的名字，而服务端正是拿它做展示名
    form.append('file', new Blob([buffer]), file.name);
    return this.api.post<UploadedFileInfo>('/api/files', form);
  }

  /** 取回文件字节：附件的原始内容与智能体生成的导出文件都经此下载 */
  downloadFile(id: string): Promise<ArrayBuffer> {
    return this.api
      .get<Blob>(`/api/files/${id}/download`, { responseType: 'blob' })
      .then((blob) => blob.arrayBuffer());
  }

  currentUser(): Promise<AuthUser> {
    return this.api.get<AuthUser>('/api/auth/me');
  }

  listConversations(): Promise<ConversationSummary[]> {
    return this.api.get<ConversationSummary[]>('/api/conversations');
  }

  getConversation(id: string): Promise<Conversation> {
    return this.api.get<Conversation>(`/api/conversations/${id}`);
  }

  /** 重命名会话：标题非空且限长（服务端同口径校验），不属于当前用户按不存在处理 */
  renameConversation(id: string, title: string): Promise<{ id: string; title: string }> {
    return this.api.patch<{ id: string; title: string }>(`/api/conversations/${id}`, { title });
  }

  deleteConversation(id: string): Promise<void> {
    return this.api.delete<void>(`/api/conversations/${id}`);
  }

  /** 当前用户可见的知识库列表（全局共享 + 自己的私有库），附每库文档数 */
  listKnowledgeBases(): Promise<KnowledgeBaseView[]> {
    return this.api.get<KnowledgeBaseView[]>('/api/knowledge/bases');
  }

  /** 新建私有库：客户端不可建 global 库 */
  createKnowledgeBase(input: { name: string; description?: string }): Promise<KnowledgeBase> {
    return this.api.post<KnowledgeBase>('/api/knowledge/bases', input);
  }

  /** 编辑库：改名或改描述，仅归属者可用 */
  updateKnowledgeBase(
    id: string,
    input: { name?: string; description?: string | null },
  ): Promise<KnowledgeBase> {
    return this.api.patch<KnowledgeBase>(`/api/knowledge/bases/${id}`, input);
  }

  /** 删除库：库内文档与片段随之级联删除 */
  deleteKnowledgeBase(id: string): Promise<void> {
    return this.api.delete<void>(`/api/knowledge/bases/${id}`);
  }

  listDocuments(knowledgeBaseId: string): Promise<KnowledgeDocument[]> {
    return this.api.get<KnowledgeDocument[]>(`/api/knowledge/bases/${knowledgeBaseId}/documents`);
  }

  addDocument(
    knowledgeBaseId: string,
    input: { title: string; content: string },
  ): Promise<KnowledgeDocument> {
    return this.api.post<KnowledgeDocument>(
      `/api/knowledge/bases/${knowledgeBaseId}/documents`,
      input,
    );
  }

  /**
   * 知识库文件上传：独立 XHR 模块拿进度与取消能力（fetch 没有上传进度事件）。
   * 返回时只代表文件已落盘，解析状态要轮询文档列表。
   */
  uploadKnowledgeFile(
    knowledgeBaseId: string,
    file: File,
    options: KnowledgeUploadOptions = {},
  ): Promise<KnowledgeDocument> {
    const raw = typeof this.baseUrl === 'function' ? this.baseUrl() : this.baseUrl;
    return uploadKnowledgeFile({
      baseUrl: raw.replace(/\/$/, ''),
      token: this.getToken(),
      knowledgeBaseId,
      file,
      options,
    });
  }

  /** 重试解析：仅 failed 文档可用，服务端重置 processing 后重新入队 */
  retryDocument(id: string): Promise<KnowledgeDocument> {
    return this.api.post<KnowledgeDocument>(`/api/knowledge/documents/${id}/retry`);
  }

  deleteDocument(id: string): Promise<void> {
    return this.api.delete<void>(`/api/knowledge/documents/${id}`);
  }

  /**
   * 取文档预览：文本类返回解析后全文，二进制类返回原始文件字节。
   * 同一个接口按文档类型给出不同内容，这里按响应类型分派，调用方不必再判类型。
   */
  async previewDocument(id: string): Promise<DocumentPreview> {
    const blob = await this.api.get<Blob>(`/api/knowledge/documents/${id}/preview`, {
      responseType: 'blob',
    });
    if (blob.type.includes('json')) {
      return JSON.parse(await blob.text()) as DocumentPreview;
    }
    return { kind: 'file', blob };
  }

  /** 逐块读取 SSE 响应，解析为带序号的帧流（序号供断线续传定位断点） */
  async *streamChat(
    payload: SendChatPayload,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamFrame> {
    // 通用客户端只把未消费的流交出来：SSE 的分帧属对话协议，由 parseSSEStream 承担
    const stream = await this.api.request<ReadableStream<Uint8Array>>({
      url: '/api/chat',
      method: 'POST',
      body: payload,
      responseType: 'stream',
      signal,
    });
    yield* parseSSEStream(stream);
  }

  /**
   * 断点续传：按轮次 ID 与已消费到的最大序号重连，服务端只重放该序号之后的帧。
   * 轮次不存在或已过期时返回 404（isNotFound 判定），由调用方降级为重新拉取整条会话。
   */
  async *resumeChat(
    roundId: string,
    lastEventId: number,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamFrame> {
    const stream = await this.api.request<ReadableStream<Uint8Array>>({
      url: `/api/chat/rounds/${roundId}/stream`,
      method: 'GET',
      params: { lastEventId },
      responseType: 'stream',
      signal,
    });
    yield* parseSSEStream(stream);
  }

  /** 停止本轮生成：服务端中止后会在流里补推一条 error 帧，客户端据此停止重连 */
  stopRound(roundId: string): Promise<void> {
    return this.api.post<void>(`/api/chat/rounds/${roundId}/stop`);
  }
}
