// 从包根按需引入：@repo/reusable 与 @repo/shared 均声明了 sideEffects: false，
// 未用到的模块（连同依赖 crypto-js 的 crypto.ts）不会被打进渲染产物
import {
  HTTP_STATUS,
  toHttpStatusCode,
  type ChatStreamEvent,
  type HttpStatusCode,
} from '@repo/reusable';
// 渲染进程只有本模块依赖 @repo/*（见 desktop-design 第 2 章）：其余模块要用共享能力
// 也经此处转发，避免第二个模块直接引包，让产物里多带无关代码
export { SESSION_EXPIRED_MESSAGE } from '@repo/reusable';
export { toErrorMessage } from '@repo/shared';
import type {
  AuthSession,
  AuthUser,
  Conversation,
  ConversationSummary,
  KnowledgeDocument,
} from '../types';
export type { ChatStreamEvent };

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
 * 带 HTTP 状态码的请求错误：调用方据此识别 401（登录失效）等需要特殊处理的情况。
 * 状态码经 toHttpStatusCode 收敛到契约取值，网关/代理注入的契约外码统一按 500 处理。
 * `message` 里仍可能带服务端返回的真实状态码（如「请求失败（HTTP 403）」），与收敛后的
 * `status` 刻意不一致：前者要可定位，后者要能安全地按契约分支，不要当成 bug 去对齐。
 */
export class ApiError extends Error {
  constructor(
    readonly status: HttpStatusCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 是否为登录失效错误 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === HTTP_STATUS.UNAUTHORIZED;
}

/** 后端智能体服务的 HTTP 客户端，含 SSE 流式对话；登录后自动携带令牌 */
export class AgentApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token = '',
  ) {}

  /**
   * 统一构造请求头，未登录时不发送 Authorization。
   * 请求体是 FormData 时不能写 Content-Type：multipart 的 boundary 必须由运行时生成，
   * 手写 application/json 会让后端完全解析不出文件。
   */
  private buildHeaders(
    body?: BodyInit | null,
    extra?: Record<string, string>,
  ): Record<string, string> {
    return {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.buildHeaders(init.body, init.headers as Record<string, string> | undefined),
    });
    if (!res.ok) throw new ApiError(toHttpStatusCode(res.status), await this.extractError(res));
    if (res.status === HTTP_STATUS.NO_CONTENT) return undefined as T;
    return (await res.json()) as T;
  }

  /** 尽量取出服务端返回的 message 字段，取不到时退化为状态码提示 */
  private async extractError(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { message?: string };
      return body.message ?? `请求失败（HTTP ${res.status}）`;
    } catch {
      return `请求失败（HTTP ${res.status}）`;
    }
  }

  health(): Promise<HealthInfo> {
    return this.request<HealthInfo>('/api/health');
  }

  register(username: string, password: string): Promise<AuthSession> {
    return this.request<AuthSession>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  login(username: string, password: string): Promise<AuthSession> {
    return this.request<AuthSession>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  logout(): Promise<void> {
    return this.request<void>('/api/auth/logout', { method: 'POST' });
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
    return this.request<UploadedFileInfo>('/api/files', { method: 'POST', body: form });
  }

  /** 取回文件字节：附件的原始内容与智能体生成的导出文件都经此下载 */
  async downloadFile(id: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.baseUrl}/api/files/${id}/download`, {
      headers: this.buildHeaders(),
    });
    if (!res.ok) throw new ApiError(toHttpStatusCode(res.status), await this.extractError(res));
    return res.arrayBuffer();
  }

  currentUser(): Promise<AuthUser> {
    return this.request<AuthUser>('/api/auth/me');
  }

  listConversations(): Promise<ConversationSummary[]> {
    return this.request<ConversationSummary[]>('/api/conversations');
  }

  getConversation(id: string): Promise<Conversation> {
    return this.request<Conversation>(`/api/conversations/${id}`);
  }

  deleteConversation(id: string): Promise<void> {
    return this.request<void>(`/api/conversations/${id}`, { method: 'DELETE' });
  }

  listDocuments(): Promise<KnowledgeDocument[]> {
    return this.request<KnowledgeDocument[]>('/api/knowledge/documents');
  }

  addDocument(input: { title: string; content: string }): Promise<KnowledgeDocument> {
    return this.request<KnowledgeDocument>('/api/knowledge/documents', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  deleteDocument(id: string): Promise<void> {
    return this.request<void>(`/api/knowledge/documents/${id}`, { method: 'DELETE' });
  }

  /** 逐块读取 SSE 响应，解析为结构化事件流 */
  async *streamChat(
    payload: SendChatPayload,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok || !res.body)
      throw new ApiError(toHttpStatusCode(res.status), await this.extractError(res));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔；最后一段可能被截断，保留到下一轮再拼
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (raw) yield JSON.parse(raw) as ChatStreamEvent;
      }
    }
  }
}
