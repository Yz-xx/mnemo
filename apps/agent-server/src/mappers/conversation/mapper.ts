import type { QueryResultRow } from 'pg';
import { truncate } from '@mnemo/shared';

export const DEFAULT_TITLE = '新对话';
/** 会话标题长度上限：自动生成时截断，手动重命名时超限直接 400，两处共用同一口径 */
export const TITLE_MAX_LENGTH = 24;

interface ConversationRow extends QueryResultRow {
  id: string;
  title: string;
  knowledge_base_id: string | null;
  created_at: Date;
  updated_at: Date;
  message_count: number;
}

/** 单会话详情行：比列表行多取滚动摘要与截断点，供上下文治理使用 */
interface ConversationDetailRow extends QueryResultRow {
  id: string;
  title: string;
  /** 首轮绑定的知识库：可空，存量会话与「不限库」会话为 null */
  knowledge_base_id: string | null;
  created_at: Date;
  updated_at: Date;
  summary: string | null;
  /** BIGINT 列：池上已注册 int8 → number 解析器，取用处仍统一 Number() 收敛 */
  summary_upto_seq: number | string | null;
}

/** 会话头行：只取标识、标题、绑定与时间，供轻量追加路径使用（不读摘要列，故不复用详情行类型） */
export interface ConversationHeaderRow extends QueryResultRow {
  id: string;
  title: string;
  knowledge_base_id: string | null;
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
