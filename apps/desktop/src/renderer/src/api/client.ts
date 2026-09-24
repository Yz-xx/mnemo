import type {
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

/** 后端智能体服务的 HTTP 客户端，含 SSE 流式对话 */
export class AgentApi {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
    if (!res.ok) throw new Error(await this.extractError(res));
    if (res.status === 204) return undefined as T;
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(await this.extractError(res));

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
