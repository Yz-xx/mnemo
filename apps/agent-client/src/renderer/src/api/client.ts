import type {
  AuthSession,
  AuthUser,
  Conversation,
  ConversationSummary,
  KnowledgeDocument,
} from '../types';
import type { ApiClient, ChatStreamEvent } from '@repo/reusable';
import { ApiError, createApiClient, isUnauthorized } from '@repo/reusable';

// 渲染进程只有本模块依赖 @repo/*（见 desktop-design 第 2 章）：其余模块要用共享能力
// 也经此处转发，避免第二个模块直接引包，让产物里多带无关代码

export { SESSION_EXPIRED_MESSAGE } from '@repo/reusable';
export { toErrorMessage } from '@repo/shared';

// 共享能力统一从本模块转发，调用方不直接引 @repo/*
export type { ChatStreamEvent };
export { ApiError, isUnauthorized };

export interface SendChatPayload {
  conversationId?: string;
  message: string;
  /** 本轮随提问一起交给智能体读取的附件 ID；服务端会校验其归属当前用户 */
  fileIds?: string[];
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
 * 后端智能体服务的 HTTP 客户端：薄外壳，构造时基于 createApiClient 创建实例，
 * 业务方法转发到通用客户端。保留类外壳是为了让现有 4 处调用方零改动；
 * token 仍按构造期固化（调用方用 computed 重建以响应登录态变化）。
 */
export class AgentApi {
  private readonly api: ApiClient;

  constructor(
    private readonly baseUrl: string,
    private readonly token = '',
  ) {
    this.api = createApiClient({
      baseURL: baseUrl,
      getToken: () => this.token,
    });
  }

  health(): Promise<HealthInfo> {
    return this.api.request<HealthInfo>('/api/health');
  }

  register(username: string, password: string): Promise<AuthSession> {
    return this.api.request<AuthSession>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  login(username: string, password: string): Promise<AuthSession> {
    return this.api.request<AuthSession>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  logout(): Promise<void> {
    return this.api.request<void>('/api/auth/logout', { method: 'POST' });
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
    return this.api.request<UploadedFileInfo>('/api/files', { method: 'POST', body: form });
  }

  /** 取回文件字节：附件的原始内容与智能体生成的导出文件都经此下载 */
  downloadFile(id: string): Promise<ArrayBuffer> {
    return this.api.downloadBlob(`/api/files/${id}/download`).then((blob) => blob.arrayBuffer());
  }

  currentUser(): Promise<AuthUser> {
    return this.api.request<AuthUser>('/api/auth/me');
  }

  listConversations(): Promise<ConversationSummary[]> {
    return this.api.request<ConversationSummary[]>('/api/conversations');
  }

  getConversation(id: string): Promise<Conversation> {
    return this.api.request<Conversation>(`/api/conversations/${id}`);
  }

  deleteConversation(id: string): Promise<void> {
    return this.api.request<void>(`/api/conversations/${id}`, { method: 'DELETE' });
  }

  listDocuments(): Promise<KnowledgeDocument[]> {
    return this.api.request<KnowledgeDocument[]>('/api/knowledge/documents');
  }

  addDocument(input: { title: string; content: string }): Promise<KnowledgeDocument> {
    return this.api.request<KnowledgeDocument>('/api/knowledge/documents', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  deleteDocument(id: string): Promise<void> {
    return this.api.request<void>(`/api/knowledge/documents/${id}`, { method: 'DELETE' });
  }

  /** 逐块读取 SSE 响应，解析为结构化事件流 */
  async *streamChat(
    payload: SendChatPayload,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    yield* this.api.streamSSE('/api/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
    });
  }
}
