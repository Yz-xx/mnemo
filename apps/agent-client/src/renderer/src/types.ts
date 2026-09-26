// 渲染进程与服务端共享的数据契约

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  /** 仅前端展示：本轮回复过程中触发的工具调用轨迹 */
  steps?: string[];
}

/** 会话列表项（不含完整消息体，减少传输量） */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface Conversation extends ConversationSummary {
  createdAt: string;
  messages: ChatMessage[];
}

/** 登录用户（服务端不会返回密码字段） */
export interface AuthUser {
  id: number;
  username: string;
}

/** 登录/注册成功后的会话信息：令牌用于后续请求鉴权 */
export interface AuthSession {
  token: string;
  user: AuthUser;
}

/** 知识库文档摘要 */
export interface KnowledgeDocument {
  id: string;
  title: string;
  chunks: number;
  createdAt: string;
}

/** 流式对话过程中服务端推送的事件 */
export type ChatStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool'; name: string; status: 'start' | 'end'; detail?: string }
  | { type: 'done'; conversationId: string; title: string }
  | { type: 'error'; message: string };
