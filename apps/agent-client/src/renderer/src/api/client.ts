import type {
  AuthSession,
  AuthUser,
  Conversation,
  ConversationSummary,
  KnowledgeDocument,
} from '../types';
import type { ChatStreamEvent, ChatStreamFrame } from '@repo/reusable';
import type { BaseUrlLike, HttpClient } from '@repo/shared';
import { encryptPassword, isNotFound, isUnauthorized, parseSSEStream } from '@repo/reusable';
import { createHttpClient } from '@repo/shared';

// 渲染进程只有本模块依赖 @repo/*（见 desktop-design 第 2 章）：其余模块要用共享能力
// 也经此处转发，避免第二个模块直接引包，让产物里多带无关代码

export { SESSION_EXPIRED_MESSAGE } from '@repo/reusable';
export { toErrorMessage } from '@repo/shared';

// 共享能力统一从本模块转发，调用方不直接引 @repo/*
export type { ChatStreamEvent, ChatStreamFrame };
export { isUnauthorized, isNotFound };

export interface SendChatPayload {
  conversationId?: string;
  message: string;
  /** 本轮随提问一起交给智能体读取的附件 ID；服务端会校验其归属当前用户 */
  fileIds?: string[];
  /** 客户端生成的轮次 ID：既作本轮的幂等键，也是断线后重连续传的定位锚 */
  roundId?: string;
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

  constructor(baseUrl: BaseUrlLike, token: string | (() => string) = '') {
    this.api = createHttpClient({
      baseURL: baseUrl,
      getToken: () => (typeof token === 'function' ? token() : token),
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

  deleteConversation(id: string): Promise<void> {
    return this.api.delete<void>(`/api/conversations/${id}`);
  }

  listDocuments(): Promise<KnowledgeDocument[]> {
    return this.api.get<KnowledgeDocument[]>('/api/knowledge/documents');
  }

  addDocument(input: { title: string; content: string }): Promise<KnowledgeDocument> {
    return this.api.post<KnowledgeDocument>('/api/knowledge/documents', input);
  }

  deleteDocument(id: string): Promise<void> {
    return this.api.delete<void>(`/api/knowledge/documents/${id}`);
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
