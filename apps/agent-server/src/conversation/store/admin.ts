import type {
  AdminConversation,
  AdminConversationPage,
  AdminConversationQuery,
  AdminConversationRow,
  CountRow,
} from './mapper.js';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import { readMessages } from './messages.js';

/**
 * 管理端会话读写：不按用户过滤，仅供后台核查与清理。
 * 从 conversations.ts 拆出——客户端 CRUD 与管理端核查是两个独立的变化原因，
 * 各自成模块后，会话表相关的单文件不再随两端能力叠加而越过 250 行上限
 * （见 .trae/rules/backend-design.md 第 1 章）。类上保留同名方法转发到此处，对外入口形态不变。
 */

/**
 * 管理端列表：返回全部会话及其所属用户。
 * 账号名由路由层批量还原（findNamesByIds），这里只给 ID——同一条编排不在两层各写一次。
 */
export async function listAllConversations(
  pool: Pool,
  query: AdminConversationQuery,
): Promise<AdminConversationPage> {
  const { keyword, page, pageSize } = query;
  const [countRows] = await pool.execute<CountRow[]>(
    'SELECT COUNT(*) AS total FROM conversations WHERE LOCATE(?, title) > 0',
    [keyword],
  );
  const [rows] = await pool.execute<AdminConversationRow[]>(
    `SELECT c.id, c.user_id, c.title, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
      WHERE LOCATE(?, c.title) > 0
      ORDER BY c.updated_at DESC
      LIMIT ? OFFSET ?`,
    [keyword, pageSize, (page - 1) * pageSize],
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      userId: Number(row.user_id),
      title: row.title,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      messageCount: Number(row.message_count ?? 0),
    })),
    total: Number(countRows[0]?.total ?? 0),
  };
}

/** 管理端读取任意会话及其全部消息：不比对归属，仅后台使用；不存在时返回 null */
export async function findConversation(pool: Pool, id: string): Promise<AdminConversation | null> {
  const [rows] = await pool.execute<AdminConversationRow[]>(
    'SELECT id, user_id, title, created_at, updated_at FROM conversations WHERE id = ? LIMIT 1',
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  const messages = await readMessages(pool, id);
  return {
    id: row.id,
    userId: Number(row.user_id),
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messages,
  };
}

/** 管理端删除任意会话：不比对归属，消息由外键级联清理 */
export async function removeConversationById(pool: Pool, id: string): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>('DELETE FROM conversations WHERE id = ?', [
    id,
  ]);
  return result.affectedRows > 0;
}
