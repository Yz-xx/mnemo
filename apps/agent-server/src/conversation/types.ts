export type MessageRole = 'user' | 'assistant' | 'system';

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** 助手本轮调用过的工具名：随回复一起落库，历史回看时还原工具标签 */
  tools?: string[];
  /** 用户提问附带的文件名：随提问一起落库，历史回看时还原附件标签 */
  attachments?: string[];
  /** 助手本轮检索命中的知识库文档名：随回复一起落库，历史回看时还原来源标签 */
  sources?: string[];
  createdAt: string;
}

/**
 * 消息的可选元数据。工具轨迹、附件名与检索来源都与正文分开存放，
 * 收敛成一个对象传递，避免 append 的可选位置参数越加越多、调用点只能靠数位置对齐。
 */
export interface MessageMeta {
  tools?: string[];
  attachments?: string[];
  sources?: string[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

/** 会话列表项，剔除消息正文以减少传输量 */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}
