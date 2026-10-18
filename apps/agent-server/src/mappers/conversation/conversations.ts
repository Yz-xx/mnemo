import type { ConversationDetailRow, ConversationRow } from './mapper.js';
import type {
  AdminConversation,
  AdminConversationPage,
  AdminConversationQuery,
  AppendResult,
  Conversation,
  ConversationHeader,
  ConversationStats,
  ConversationSummary,
  MessageMeta,
  MessageRole,
} from '../../entities/conversation.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import type { MetricsRegistry } from '../../infrastructure/observability/index.js';
import { isUuid } from '../../utils/uuid.js';
import { findConversation, listAllConversations, removeConversationById } from './admin.js';
import { appendMessage, createConversation } from './append.js';
import { readMessages } from './messages.js';
import { readStats } from './stats.js';
import { saveConversationSummary } from './summary.js';

/** 会话持久化（PostgreSQL）：所有读写都按 user_id 隔离，实现多账号数据互不可见 */
export class ConversationStore {
  /** metrics 可选：未注入时（如单测）埋点整体短路，不影响读写行为 */
  constructor(
    private readonly pool: DbPool,
    private readonly metrics?: MetricsRegistry,
  ) {}

  /** 按最近更新时间倒序列出该用户的会话摘要 */
  async list(userId: number): Promise<ConversationSummary[]> {
    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT c.id, c.title, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
        WHERE c.user_id = $1
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
    // 非法 ID 不可能命中记录，直接判为不存在，也避免 uuid 列比较时抛类型错误
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<ConversationDetailRow>(
      `SELECT id, title, created_at, updated_at, summary, summary_upto_seq
         FROM conversations WHERE id = $1 AND user_id = $2 LIMIT 1`,
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

  /** 新建空会话：实现见 append.ts；保留同名方法，维持路由依赖的单一入口形态 */
  create(userId: number): Promise<Conversation> {
    return createConversation(this.pool, userId);
  }

  /**
   * 追加一条消息并同步会话标题与更新时间（实现见 append.ts）。
   * 调用方已读入的会话经 known 传入即零查询；未传时只读会话头，使单轮成本不随消息数增长。
   */
  append(
    userId: number,
    id: string | undefined,
    role: MessageRole,
    content: string,
    meta: MessageMeta = {},
    known?: ConversationHeader,
  ): Promise<AppendResult> {
    return appendMessage({
      pool: this.pool,
      metrics: this.metrics,
      userId,
      id,
      role,
      content,
      meta,
      known,
    });
  }

  /** 删除会话；消息通过外键级联删除 */
  async remove(userId: number, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const { rowCount } = await this.pool.query(
      'DELETE FROM conversations WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** 删除该用户的全部对话；消息由外键级联清理 */
  async removeAllByUser(userId: number): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM conversations WHERE user_id = $1', [
      userId,
    ]);
    return rowCount ?? 0;
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
