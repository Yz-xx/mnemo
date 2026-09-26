// 从包根按需引入：@repo/shared 声明了 sideEffects: false，
// 未用到的模块（连同依赖 crypto-js 的 crypto.ts）不会被打进渲染产物
import { HTTP_STATUS } from '@repo/shared';
import type {
  AuthSession,
  AuthUser,
  ChatStreamEvent,
  Conversation,
  ConversationSummary,
  KnowledgeDocument,
} from '../types';

export interface SendChatPayload {
  conversationId?: string;
  message: string;
}

/** 服务端健康信息，用于界面展示当前模型与知识库状态 */
export interface HealthInfo {
  status: string;
  provider: string;
  model: string;
  knowledgeEnabled: boolean;
}

/** 带 HTTP 状态码的请求错误：调用方据此识别 401（登录失效）等需要特殊处理的情况 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
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

  /** 统一构造请求头，未登录时不发送 Authorization */
  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.buildHeaders(init.headers as Record<string, string> | undefined),
    });
    if (!res.ok) throw new ApiError(res.status, await this.extractError(res));
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
    if (!res.ok || !res.body) throw new ApiError(res.status, await this.extractError(res));

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
