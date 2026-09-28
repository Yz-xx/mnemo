import type {
  Conversation,
  ConversationSummary,
  MessageMeta,
  MessageRole,
  StoredMessage,
} from '../types.js';
import type {
  AdminConversation,
  AdminConversationPage,
  AdminConversationQuery,
  AdminConversationRow,
  ConversationRow,
  ConversationStats,
  CountRow,
} from './mapper.js';
import type { MessageRow } from './messages.js';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { buildTitle, DEFAULT_TITLE } from './mapper.js';
import { toStoredMessage } from './messages.js';
import { readStats } from './stats.js';

/** 会话持久化（MySQL）：所有读写都按 user_id 隔离，实现多账号数据互不可见 */
export class ConversationStore {
  constructor(private readonly pool: Pool) {}

  /** 按最近更新时间倒序列出该用户的会话摘要 */
  async list(userId: number): Promise<ConversationSummary[]> {
    const [rows] = await this.pool.execute<ConversationRow[]>(
      `SELECT c.id, c.title, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
        WHERE c.user_id = ?
        ORDER BY c.updated_at DESC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at.toISOString(),
      messageCount: Number(row.message_count ?? 0),
    }));
  }

  /** 读取单个会话及其全部消息；不属于该用户时返回 null */
  async get(userId: number, id: string): Promise<Conversation | null> {
    const [rows] = await this.pool.execute<ConversationRow[]>(
      'SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId],
    );
    const row = rows[0];
    if (!row) return null;

    // seq 为自增列，保证消息顺序与写入顺序一致
    const [messageRows] = await this.pool.execute<MessageRow[]>(
      'SELECT id, role, content, tools, attachments, sources, created_at FROM messages WHERE conversation_id = ? ORDER BY seq',
      [id],
    );
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      messages: messageRows.map(toStoredMessage),
    };
  }

  async create(userId: number): Promise<Conversation> {
    const now = new Date();
    const conversation: Conversation = {
      id: randomUUID(),
      title: DEFAULT_TITLE,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messages: [],
    };
    await this.pool.execute(
      'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [conversation.id, userId, conversation.title, now, now],
    );
    return conversation;
  }

  /**
   * 追加一条消息；未指定会话或会话不存在时自动新建。
   * 工具轨迹、附件名与检索来源统一经 meta 传入：三者都只有部分角色会用到，
   * 若继续按位置参数逐个追加，调用点迟早只能靠数位置才能对齐。
   */
  async append(
    userId: number,
    id: string | undefined,
    role: MessageRole,
    content: string,
    meta: MessageMeta = {},
  ): Promise<Conversation> {
    const { tools, attachments, sources } = meta;
    const conversation = (id ? await this.get(userId, id) : null) ?? (await this.create(userId));
    const message: StoredMessage = {
      id: randomUUID(),
      role,
      content,
      tools,
      attachments,
      sources,
      createdAt: new Date().toISOString(),
    };
    conversation.messages.push(message);

    // 首条用户消息用于生成会话标题
    const title =
      conversation.title === DEFAULT_TITLE && role === 'user'
        ? buildTitle(content)
        : conversation.title;
    const now = new Date();
    conversation.title = title;
    conversation.updatedAt = now.toISOString();

    // 空数组写 null，避免没有元数据的消息也存一个空数组占位
    const toJson = (value: string[] | undefined): string | null =>
      value && value.length > 0 ? JSON.stringify(value) : null;
    await this.pool.execute(
      'INSERT INTO messages (id, conversation_id, role, content, tools, attachments, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        message.id,
        conversation.id,
        role,
        content,
        toJson(tools),
        toJson(attachments),
        toJson(sources),
        new Date(message.createdAt),
      ],
    );
    await this.pool.execute('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [
      title,
      now,
      conversation.id,
    ]);

    return conversation;
  }

  /** 删除会话；消息通过外键级联删除 */
  async remove(userId: number, id: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      'DELETE FROM conversations WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    return result.affectedRows > 0;
  }

  /** 删除该用户的全部对话；消息由外键级联清理 */
  async removeAllByUser(userId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      'DELETE FROM conversations WHERE user_id = ?',
      [userId],
    );
    return result.affectedRows;
  }

  /** 总览统计：跨用户聚合，实现见 stats.ts；同名方法保留，路由的依赖形态不变 */
  async stats(days: number): Promise<ConversationStats> {
    return readStats(this.pool, days);
  }

  /**
   * 管理端列表：不按用户过滤，返回全部会话及其所属用户。
   * 账号名由路由层批量还原（findNamesByIds），这里只给 ID——同一条编排不在两层各写一次。
   */
  async listAll(query: AdminConversationQuery): Promise<AdminConversationPage> {
    const { keyword, page, pageSize } = query;
    const [countRows] = await this.pool.execute<CountRow[]>(
      'SELECT COUNT(*) AS total FROM conversations WHERE LOCATE(?, title) > 0',
      [keyword],
    );
    const [rows] = await this.pool.execute<AdminConversationRow[]>(
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
  async find(id: string): Promise<AdminConversation | null> {
    const [rows] = await this.pool.execute<AdminConversationRow[]>(
      'SELECT id, user_id, title, created_at, updated_at FROM conversations WHERE id = ? LIMIT 1',
      [id],
    );
    const row = rows[0];
    if (!row) return null;

    const [messageRows] = await this.pool.execute<MessageRow[]>(
      'SELECT id, role, content, tools, attachments, sources, created_at FROM messages WHERE conversation_id = ? ORDER BY seq',
      [id],
    );
    return {
      id: row.id,
      userId: Number(row.user_id),
      title: row.title,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      messages: messageRows.map(toStoredMessage),
    };
  }

  /** 管理端删除任意会话：不比对归属，消息由外键级联清理 */
  async removeById(id: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      'DELETE FROM conversations WHERE id = ?',
      [id],
    );
    return result.affectedRows > 0;
  }
}
