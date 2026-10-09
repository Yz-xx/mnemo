import type { MessageRole, StoredMessage } from '../types.js';
import type { Pool, RowDataPacket } from 'mysql2/promise';

interface MessageRow extends RowDataPacket {
  /** 自增序号：BIGINT UNSIGNED 经驱动读回可能是字符串，取值处统一 Number() 收敛 */
  seq: number | string;
  id: string;
  role: MessageRole;
  content: string;
  /**
   * mysql2 默认会自动解析 JSON 列为 JS 对象，因此这里可能是 string[]（已解析）
   * 或 string（某些配置下未解析）；无工具调用时为 null
   */
  tools: string[] | string | null;
  /** 同 tools，可能是已解析的 string[] 或原始字符串；无附件时为 null */
  attachments: string[] | string | null;
  /** 同 tools；无检索来源时为 null */
  sources: string[] | string | null;
  created_at: Date;
}

/**
 * 解析 JSON 列的工具/附件数组。
 * mysql2 默认自动把 JSON 列解析为 JS 对象，此时 raw 已是数组；
 * 只有在关闭自动解析的配置下才会是字符串，需手动 JSON.parse。
 * 两种情况都要兼容，否则已入库的标签会在读取时被静默吞掉。
 */
export function parseJsonArray(raw: string[] | string | null): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw.length > 0 ? raw : undefined;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length > 0 ? (parsed as string[]) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    seq: Number(row.seq),
    id: row.id,
    role: row.role,
    content: row.content,
    tools: parseJsonArray(row.tools),
    attachments: parseJsonArray(row.attachments),
    sources: parseJsonArray(row.sources),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 读取某会话的全部消息，按 seq 升序。
 * 会话详情（客户端）与后台核查（管理端）共用这一条查询，避免两处各写一份 SELECT 后漂移。
 */
export async function readMessages(pool: Pool, conversationId: string): Promise<StoredMessage[]> {
  const [rows] = await pool.execute<MessageRow[]>(
    'SELECT seq, id, role, content, tools, attachments, sources, created_at FROM messages WHERE conversation_id = ? ORDER BY seq',
    [conversationId],
  );
  return rows.map(toStoredMessage);
}

export type { MessageRow };
