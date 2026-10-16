import type { DbPool } from '../../db/pool.js';
import type { MessageRole, StoredMessage } from '../types.js';
import type { QueryResultRow } from 'pg';

interface MessageRow extends QueryResultRow {
  /** BIGINT 列：池上已注册 int8 → number 解析器，取用处仍统一 Number() 收敛 */
  seq: number | string;
  id: string;
  role: MessageRole;
  content: string;
  /** jsonb 列：pg 驱动已解析为数组；无工具调用时为 null */
  tools: string[] | null;
  /** 同 tools，无附件时为 null */
  attachments: string[] | null;
  /** 同 tools；无检索来源时为 null */
  sources: string[] | null;
  created_at: Date;
}

/**
 * 归一 jsonb 列的工具/附件数组。
 * pg 驱动直接返回已解析的数组，这里只需把「空数组」收敛为 undefined——
 * 写入侧已把空数组写成 null，但历史或人工补的数据可能留下空数组，
 * 统一按「没有值」处理，调用方才能只判有无。
 */
export function toArray(raw: string[] | null): string[] | undefined {
  return raw && raw.length > 0 ? raw : undefined;
}

/** 行转存储消息：把可能读回字符串的 BIGINT seq 收敛为数字，jsonb 列经 toArray 归一 */
export function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    seq: Number(row.seq),
    id: row.id,
    role: row.role,
    content: row.content,
    tools: toArray(row.tools),
    attachments: toArray(row.attachments),
    sources: toArray(row.sources),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 读取某会话的全部消息，按 seq 升序。
 * 会话详情（客户端）与后台核查（管理端）共用这一条查询，避免两处各写一份 SELECT 后漂移。
 */
export async function readMessages(pool: DbPool, conversationId: string): Promise<StoredMessage[]> {
  const { rows } = await pool.query<MessageRow>(
    'SELECT seq, id, role, content, tools, attachments, sources, created_at FROM messages WHERE conversation_id = $1 ORDER BY seq',
    [conversationId],
  );
  return rows.map(toStoredMessage);
}

export type { MessageRow };
