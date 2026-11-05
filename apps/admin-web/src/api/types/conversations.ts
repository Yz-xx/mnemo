/** 消息角色：与桌面端会话历史同构 */
export type MessageRole = 'user' | 'assistant' | 'system';

/** 管理端消息：只读展示，工具、附件与检索来源按需还原为标签 */
export interface AdminMessage {
  id: string;
  role: MessageRole;
  content: string;
  tools?: string[];
  attachments?: string[];
  sources?: string[];
  createdAt: string;
}

/** 管理端会话摘要：含所属用户与归属账号名 */
export interface AdminConversationSummary {
  id: string;
  userId: number;
  ownerName: string | null;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 管理端会话详情：整条会话外带归属账号名 */
export interface AdminConversationDetail {
  id: string;
  userId: number;
  ownerName: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AdminMessage[];
}
