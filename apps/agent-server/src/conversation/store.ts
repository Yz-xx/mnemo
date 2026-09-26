import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { truncate } from '@repo/shared';
import type { Conversation, ConversationSummary, MessageRole, StoredMessage } from './types.js';

const DEFAULT_TITLE = '新对话';
const TITLE_MAX_LENGTH = 24;

interface ConversationRow extends RowDataPacket {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  message_count: number;
}

interface MessageRow extends RowDataPacket {
  id: string;
  role: MessageRole;
  content: string;
  created_at: Date;
}

/** 复用公共库的截断能力，把首条用户消息转为会话标题 */
function buildTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized ? truncate(normalized, TITLE_MAX_LENGTH) : DEFAULT_TITLE;
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at.toISOString(),
  };
}

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
      'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY seq',
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

  /** 追加一条消息；未指定会话或会话不存在时自动新建 */
  async append(
    userId: number,
    id: string | undefined,
    role: MessageRole,
    content: string,
  ): Promise<Conversation> {
    const conversation = (id ? await this.get(userId, id) : null) ?? (await this.create(userId));
    const message: StoredMessage = {
      id: randomUUID(),
      role,
      content,
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

    await this.pool.execute(
      'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [message.id, conversation.id, role, content, new Date(message.createdAt)],
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
}
