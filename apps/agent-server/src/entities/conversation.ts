/**
 * 会话与消息实体。
 * 消息元数据（工具轨迹、附件名、检索来源）与正文分开成列随消息一起落库，
 * 空值写 null 而非 []，切换历史会话时按原样回读即可还原标签。
 */

import type { KnowledgeCitation } from '@mnemo/reusable';

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * 消息来源：新版是可定位引用，旧版落库存的是文档名。
 * 读回时两种形状都可能出现，消费端按形状兼容（旧版没有文档 ID，不提供预览入口）。
 */
export type StoredCitation = KnowledgeCitation | string;

/** 一条已落库的消息 */
export interface StoredMessage {
  /** 自增序号：与写入顺序一致，也是滚动摘要截断点的比较依据 */
  seq: number;
  id: string;
  role: MessageRole;
  content: string;
  /** 助手本轮调用过的工具名：随回复一起落库，历史回看时还原工具标签 */
  tools?: string[];
  /** 用户提问附带的文件名：随提问一起落库，历史回看时还原附件标签 */
  attachments?: string[];
  /** 助手本轮检索命中的可定位引用：随回复一起落库，历史回看时还原引用卡片 */
  sources?: StoredCitation[];
  createdAt: string;
}

/**
 * 消息的可选元数据。工具轨迹、附件名与检索来源都与正文分开存放，
 * 收敛成一个对象传递，避免 append 的可选位置参数越加越多、调用点只能靠数位置对齐。
 */
export interface MessageMeta {
  tools?: string[];
  attachments?: string[];
  sources?: KnowledgeCitation[];
}

/**
 * 会话头：只有标识、标题、时间与知识库绑定，不含消息与摘要。
 * 追加消息时只需要这些字段（判断归属、是否首条提问、回传标题），
 * 拿到它就不必回读整条会话历史（见 docs/adr/0010 决策 13）。
 */
export interface ConversationHeader {
  id: string;
  title: string;
  /** 首轮绑定的知识库：限定检索范围；存量会话与「不限库」会话无该字段 */
  knowledgeBaseId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 整条会话：会话头 + 滚动摘要 + 消息列表 */
export interface Conversation extends ConversationHeader {
  /** 滚动摘要：更早对话的压缩结果；尚无摘要时不带该字段 */
  summary?: string;
  /** 摘要已覆盖到的最后一条消息 seq；尚无摘要时不带该字段 */
  summaryUptoSeq?: number;
  messages: StoredMessage[];
}

/** 追加消息的结果：会话头 + 刚写入的消息（含自增 seq）；历史由调用方一次性读入，不由这里回读 */
export interface AppendResult {
  conversation: ConversationHeader;
  message: StoredMessage;
}

/** 会话列表项，剔除消息正文以减少传输量 */
export interface ConversationSummary {
  id: string;
  title: string;
  /** 首轮绑定的知识库：列表条目据此显示绑定库；「不限库」会话无该字段 */
  knowledgeBaseId?: string;
  updatedAt: string;
  messageCount: number;
}

/** 消息趋势的一个数据点：date 为 YYYY-MM-DD，count 为该日消息数 */
export interface MessageTrendPoint {
  date: string;
  count: number;
}

/** 总览统计：会话与消息规模 + 近 N 天活跃度，供管理后台展示 */
export interface ConversationStats {
  total: number;
  messages: number;
  messagesToday: number;
  trend: MessageTrendPoint[];
}

/** 管理端会话摘要：在客户端摘要之上补所属用户与创建时间 */
export interface AdminConversationSummary extends ConversationSummary {
  userId: number;
  createdAt: string;
}

/** 管理端会话：整条会话外带所属用户，供后台核查对话内容 */
export interface AdminConversation extends Conversation {
  userId: number;
}

/** 管理端列表查询条件：keyword 按标题包含匹配，分页已在路由层收敛 */
export interface AdminConversationQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 管理端分页结果：total 为满足条件的总数 */
export interface AdminConversationPage {
  items: AdminConversationSummary[];
  total: number;
}
