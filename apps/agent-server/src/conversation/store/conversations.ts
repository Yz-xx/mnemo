import type {
  AppendResult,
  Conversation,
  ConversationHeader,
  ConversationSummary,
  MessageMeta,
  MessageRole,
} from '../types.js';
import type {
  AdminConversation,
  AdminConversationPage,
  AdminConversationQuery,
  ConversationDetailRow,
  ConversationHeaderRow,
  ConversationRow,
  ConversationStats,
} from './mapper.js';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { findConversation, listAllConversations, removeConversationById } from './admin.js';
import { buildTitle, DEFAULT_TITLE } from './mapper.js';
import { readMessages } from './messages.js';
import { readStats } from './stats.js';
import { saveConversationSummary } from './summary.js';

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
    const [rows] = await this.pool.execute<ConversationDetailRow[]>(
      `SELECT id, title, created_at, updated_at, summary, summary_upto_seq
         FROM conversations WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId],
    );
    const row = rows[0];
    if (!row) return null;

    // 消息按 seq 升序读出，与写入顺序一致；滚动摘要的截断点也按它比较
    const messages = await readMessages(this.pool, id);
    return {
      id: row.id,
      title: row.title,
      // 空列不带字段：调用方以「有没有值」判断是否已有摘要，无需再比对 null
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.summary_upto_seq === null ? {} : { summaryUptoSeq: Number(row.summary_upto_seq) }),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      messages,
    };
  }

  /** 保存滚动摘要并推进截断点：实现在 summary.ts，条件更新保证截断点只增不减 */
  saveSummary(userId: number, id: string, summary: string, uptoSeq: number): Promise<boolean> {
    return saveConversationSummary(this.pool, userId, id, summary, uptoSeq);
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
   * 只读会话头（标识 / 标题 / 时间），不读消息。
   * 追加消息只需据此判断归属与是否首条提问，避免为此拉回整条会话历史。
   */
  private async readHeader(userId: number, id: string): Promise<ConversationHeader | null> {
    const [rows] = await this.pool.execute<ConversationHeaderRow[]>(
      `SELECT id, title, created_at, updated_at
         FROM conversations WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /**
   * 追加一条消息并同步会话标题与更新时间（轻量路径：不回读全量历史）。
   * 调用方已读入的会话经 known 传入即零查询；未传时只读会话头（不读消息），
   * 使单轮成本不再随会话消息数线性累加（见 docs/adr/0010 决策 13）。
   * 工具轨迹、附件名与检索来源统一经 meta 传入：三者都只有部分角色会用到，
   * 若继续按位置参数逐个追加，调用点迟早只能靠数位置才能对齐。
   * 返回会话头与刚写入的消息；本轮历史由调用方一次性读入后自行拼接。
   */
  async append(
    userId: number,
    id: string | undefined,
    role: MessageRole,
    content: string,
    meta: MessageMeta = {},
    known?: ConversationHeader,
  ): Promise<AppendResult> {
    const { tools, attachments, sources } = meta;
    const header: ConversationHeader =
      known ?? (id ? await this.readHeader(userId, id) : null) ?? (await this.create(userId));
    const messageId = randomUUID();
    const now = new Date();

    // 空数组写 null，避免没有元数据的消息也存一个空数组占位
    const toJson = (value: string[] | undefined): string | null =>
      value && value.length > 0 ? JSON.stringify(value) : null;

    // 先入库再回填自增 seq：滚动摘要按 seq 定位截断点，缺了它未摘要段会被整段过滤掉
    const [result] = await this.pool.execute<ResultSetHeader>(
      'INSERT INTO messages (id, conversation_id, role, content, tools, attachments, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        messageId,
        header.id,
        role,
        content,
        toJson(tools),
        toJson(attachments),
        toJson(sources),
        now,
      ],
    );

    // 首条用户消息用于生成会话标题
    const title =
      header.title === DEFAULT_TITLE && role === 'user' ? buildTitle(content) : header.title;

    await this.pool.execute('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [
      title,
      now,
      header.id,
    ]);

    return {
      conversation: { ...header, title, updatedAt: now.toISOString() },
      message: {
        seq: Number(result.insertId),
        id: messageId,
        role,
        content,
        tools,
        attachments,
        sources,
        createdAt: now.toISOString(),
      },
    };
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

  /** 管理端列表：实现见 admin.ts；类上保留同名方法，维持路由依赖的单一入口形态 */
  listAll(query: AdminConversationQuery): Promise<AdminConversationPage> {
    return listAllConversations(this.pool, query);
  }

  /** 管理端读取任意会话及其全部消息：实现见 admin.ts */
  find(id: string): Promise<AdminConversation | null> {
    return findConversation(this.pool, id);
  }

  /** 管理端删除任意会话：实现见 admin.ts，消息由外键级联清理 */
  removeById(id: string): Promise<boolean> {
    return removeConversationById(this.pool, id);
  }
}
