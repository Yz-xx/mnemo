import type { Conversation, ConversationSummary } from '../types.js';
import type { QueryResultRow } from 'pg';
import { truncate } from '@repo/shared';

export const DEFAULT_TITLE = '新对话';
const TITLE_MAX_LENGTH = 24;

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

interface ConversationRow extends QueryResultRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  message_count: number;
}

/** 单会话详情行：比列表行多取滚动摘要与截断点，供上下文治理使用 */
interface ConversationDetailRow extends QueryResultRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  summary: string | null;
  /** BIGINT 列：池上已注册 int8 → number 解析器，取用处仍统一 Number() 收敛 */
  summary_upto_seq: number | string | null;
}

/** 会话头行：只取标识、标题与时间，供轻量追加路径使用（不读摘要列，故不复用详情行类型） */
export interface ConversationHeaderRow extends QueryResultRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

/** 管理端列表行：在客户端摘要列之上多取所属用户 */
interface AdminConversationRow extends QueryResultRow {
  id: string;
  user_id: number;
  title: string;
  created_at: Date;
  updated_at: Date;
  message_count: number;
}

interface CountRow extends QueryResultRow {
  total: number;
}

/** 复用公共库的截断能力，把首条用户消息转为会话标题 */
export function buildTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized ? truncate(normalized, TITLE_MAX_LENGTH) : DEFAULT_TITLE;
}

export type { AdminConversationRow, ConversationDetailRow, ConversationRow, CountRow };
