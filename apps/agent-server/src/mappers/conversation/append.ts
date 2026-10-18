import type { ConversationHeaderRow } from './mapper.js';
import type {
  AppendResult,
  Conversation,
  ConversationHeader,
  MessageMeta,
  MessageRole,
} from '../../entities/conversation.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import type { MetricsRegistry } from '../../infrastructure/observability/index.js';
import { randomUUID } from 'node:crypto';
import { METRIC } from '../../infrastructure/observability/index.js';
import { isUuid } from '../../utils/uuid.js';
import { buildTitle, DEFAULT_TITLE } from './mapper.js';

/**
 * 只读会话头（标识 / 标题 / 时间），不读消息。
 * 追加消息只需据此判断归属与是否首条提问，避免为此拉回整条会话历史。
 */
export async function readHeader(
  pool: DbPool,
  userId: number,
  id: string,
): Promise<ConversationHeader | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<ConversationHeaderRow>(
    `SELECT id, title, created_at, updated_at
       FROM conversations WHERE id = $1 AND user_id = $2 LIMIT 1`,
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

/** 新建空会话：标题先落默认值，首条用户消息到达时再改写 */
export async function createConversation(pool: DbPool, userId: number): Promise<Conversation> {
  const now = new Date();
  const conversation: Conversation = {
    id: randomUUID(),
    title: DEFAULT_TITLE,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    messages: [],
  };
  await pool.query(
    'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
    [conversation.id, userId, conversation.title, now, now],
  );
  return conversation;
}

/**
 * 追加一条消息并同步会话标题与更新时间（轻量路径：不回读全量历史）。
 * 调用方已读入的会话经 known 传入即零查询；未传时只读会话头（不读消息），
 * 使单轮成本不再随会话消息数线性累加（见 docs/adr/0010 决策 13）。
 * 工具轨迹、附件名与检索来源统一经 meta 传入：三者都只有部分角色会用到，
 * 若继续按位置参数逐个追加，调用点迟早只能靠数位置才能对齐。
 * 返回会话头与刚写入的消息；本轮历史由调用方一次性读入后自行拼接。
 */
export async function appendMessage(input: {
  pool: DbPool;
  metrics?: MetricsRegistry;
  userId: number;
  id: string | undefined;
  role: MessageRole;
  content: string;
  meta?: MessageMeta;
  known?: ConversationHeader;
}): Promise<AppendResult> {
  const { pool, metrics, userId, id, role, content, meta = {}, known } = input;
  const startedAt = Date.now();
  const { tools, attachments, sources } = meta;
  const header: ConversationHeader =
    known ??
    (id ? await readHeader(pool, userId, id) : null) ??
    (await createConversation(pool, userId));
  const messageId = randomUUID();
  const now = new Date();

  // 空数组写 null，避免没有元数据的消息也存一个空数组占位
  const toJson = (value: string[] | undefined): string | null =>
    value && value.length > 0 ? JSON.stringify(value) : null;

  // 先入库再回填自增 seq：滚动摘要按 seq 定位截断点，缺了它未摘要段会被整段过滤掉。
  // PG 没有 insertId，改用 RETURNING 把自增 seq 随插入一并取回
  const { rows: inserted } = await pool.query<{ seq: number | string }>(
    `INSERT INTO messages (id, conversation_id, role, content, tools, attachments, sources, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING seq`,
    [messageId, header.id, role, content, toJson(tools), toJson(attachments), toJson(sources), now],
  );

  // 首条用户消息用于生成会话标题
  const title =
    header.title === DEFAULT_TITLE && role === 'user' ? buildTitle(content) : header.title;

  await pool.query('UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3', [
    title,
    now,
    header.id,
  ]);

  // 单条消息落库耗时（含插入与更新会话时间）：与检索 / 模型分段区分，定位慢在哪一环
  metrics?.observe(METRIC.DB_APPEND, Date.now() - startedAt);

  return {
    conversation: { ...header, title, updatedAt: now.toISOString() },
    message: {
      seq: Number(inserted[0]?.seq ?? 0),
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
