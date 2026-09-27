import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { truncate } from '@repo/shared';
import type {
  Conversation,
  ConversationSummary,
  MessageMeta,
  MessageRole,
  StoredMessage,
} from './types.js';

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

/** 复用公共库的截断能力，把首条用户消息转为会话标题 */
function buildTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized ? truncate(normalized, TITLE_MAX_LENGTH) : DEFAULT_TITLE;
}

/**
 * 解析 JSON 列的工具/附件数组。
 * mysql2 默认自动把 JSON 列解析为 JS 对象，此时 raw 已是数组；
 * 只有在关闭自动解析的配置下才会是字符串，需手动 JSON.parse。
 * 两种情况都要兼容，否则已入库的标签会在读取时被静默吞掉。
 */
function parseJsonArray(raw: string[] | string | null): string[] | undefined {
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

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    tools: parseJsonArray(row.tools),
    attachments: parseJsonArray(row.attachments),
    sources: parseJsonArray(row.sources),
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
}
