import type { PoolClient } from 'pg';
import { toSql } from 'pgvector';

/**
 * 知识库向量存储的 PostgreSQL 方言层（见 docs/adr/0012）。
 *
 * 表名、DDL、检索 SQL、写入参数构建与会话级检索参数都收敛在这里，
 * 适配器（mappers/knowledge/pgStore.ts）只做编排；可见性过滤、行形状、写入参数都在本模块拼装，
 * 值一律走绑定参数，不拼字符串。
 */

export const DOCUMENTS_TABLE = 'knowledge_documents';
export const CHUNKS_TABLE = 'knowledge_chunks';
/** 向量索引名：重建与失效判定都要按它在 pg_class 里查 */
export const VECTOR_INDEX = 'idx_chunks_embedding';

/**
 * 会话级检索参数：带过滤条件时 HNSW 会「走得不够远」而召不满 LIMIT，
 * relaxed_order 让索引持续取候选直到满足过滤或撞上扫描上界（见 docs/adr/0012 决策 4）。
 * 每条新连接装载一次即可：参数对连接池复用无害，且 relaxed_order 是安全默认。
 * 多语句用简单查询协议一次发完，避免逐条往返。
 */
export const SESSION_PARAMETERS = [
  "SET hnsw.iterative_scan = 'relaxed_order'",
  'SET hnsw.max_scan_tuples = 20000',
].join('; ');

/** 文档表列序：插入参数必须与 toDocumentParams 一一对应 */
export const DOCUMENT_COLUMNS = [
  'id',
  'title',
  'scope',
  'owner_user_id',
  'chunks',
  'embedding_model',
  'dim',
  'created_at',
  'content',
  'updated_at',
] as const;

/** 片段表列序：向量列叫 embedding，写入时序列化成 pgvector 文本格式（见 toChunkParams） */
export const CHUNK_COLUMNS = [
  'id',
  'document_id',
  'chunk_index',
  'title',
  'content',
  'scope',
  'owner_user_id',
  'created_at',
  'embedding',
] as const;

/**
 * 可见性谓词：全局文档对所有人生效，私有文档只对归属者生效。
 * 用户 ID 走绑定参数，不构成注入面；索引参数位置由调用方指定
 * （列表里它是 $1，检索里向量占了 $1，它退到 $2）
 */
function visibility(userParam: string): string {
  return `(scope = 'global' OR owner_user_id = ${userParam})`;
}

/** 文档表 DDL：content 与 updated_at 可空——旧文档可能未留存原文与编辑时间 */
export function createDocumentsSql(): string {
  return `
CREATE TABLE IF NOT EXISTS ${DOCUMENTS_TABLE} (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('global', 'private')),
  owner_user_id bigint NULL,
  chunks integer NOT NULL,
  embedding_model text NOT NULL,
  dim integer NOT NULL,
  created_at timestamptz(3) NOT NULL,
  content text NULL,
  updated_at timestamptz(3) NULL
)`.trim();
}

/**
 * 片段表 DDL：向量维度在建表时固定，而 vector(N) 的 N 不能占位参数化，
 * 因此按「首个向量维度」拼入，拼前先做正整数白名单校验（无注入面）。
 * chunk_index 记录片段在同一文档内的原始次序：旧文档按分片拼正文必须有个稳定序（见 stitchChunks）。
 */
export function createChunksSql(dim: number): string {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`向量维度非法：${dim}`);
  return `
CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES ${DOCUMENTS_TABLE} (id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  scope text NOT NULL,
  owner_user_id bigint NULL,
  created_at timestamptz(3) NOT NULL,
  embedding vector(${dim}) NOT NULL
)`.trim();
}

/** 片段表的常规索引：可见性过滤与按文档拼正文 / 级联删除各用到一条，IF NOT EXISTS 幂等 */
export const CREATE_CHUNK_INDEXES_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_chunks_visibility ON ${CHUNKS_TABLE} (scope, owner_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON ${CHUNKS_TABLE} (document_id)`,
].join('; ');

/**
 * 向量索引：HNSW + 余弦操作符（见 docs/adr/0012 决策 3，否决需预训练聚类中心的 IVFFlat）。
 * 用 CONCURRENTLY 建，避免建索引期间长锁写入；代价是失败会留下 INVALID 索引，
 * 故重建前先按 indisvalid 判定，无效索引要先删。
 */
export const CREATE_VECTOR_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${VECTOR_INDEX} ON ${CHUNKS_TABLE} USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`;
export const VECTOR_INDEX_STATE_SQL = `SELECT CASE WHEN i.indisvalid THEN 'valid' ELSE 'invalid' END AS state FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`;
export const DROP_VECTOR_INDEX_SQL = `DROP INDEX CONCURRENTLY IF EXISTS ${VECTOR_INDEX}`;

/**
 * 向量索引就位：不存在、或上次 CONCURRENTLY 建失败（留下 INVALID 索引）时重建。
 * 无效索引会被查询直接忽略，不先删掉的话重建会因「已存在」而跳过。
 */
export async function ensureVectorIndex(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ state: string }>(VECTOR_INDEX_STATE_SQL, [VECTOR_INDEX]);
  const state = rows[0]?.state;
  if (state === 'valid') return;
  if (state) await client.query(DROP_VECTOR_INDEX_SQL);
  await client.query(CREATE_VECTOR_INDEX_SQL);
}

/** 检索 SQL：score 取 1 - 余弦距离，与 minScore 阈值同口径 */
export const FIND_DOCUMENT_SQL = `SELECT * FROM ${DOCUMENTS_TABLE} WHERE id = $1`;
export const LIST_DOCUMENTS_SQL = `SELECT * FROM ${DOCUMENTS_TABLE} WHERE ${visibility('$1')}`;
export const LIST_ALL_DOCUMENTS_SQL = `SELECT * FROM ${DOCUMENTS_TABLE}`;
export const COUNT_DOCUMENTS_SQL = `SELECT COUNT(*) AS count FROM ${DOCUMENTS_TABLE}`;
export const COUNT_CHUNKS_SQL = `SELECT COUNT(*) AS count FROM ${CHUNKS_TABLE}`;
export const STITCH_CHUNKS_SQL = `SELECT content FROM ${CHUNKS_TABLE} WHERE document_id = $1 ORDER BY chunk_index`;
export const READ_BASELINE_SQL = `SELECT dim, embedding_model FROM ${DOCUMENTS_TABLE} LIMIT 1`;
export const SEARCH_CHUNKS_SQL = `
SELECT document_id, title, content, 1 - (embedding <=> $1) AS score
FROM ${CHUNKS_TABLE}
WHERE ${visibility('$2')}
ORDER BY embedding <=> $1
LIMIT $3`.trim();

/** 时间列读回的是 Date 对象，业务侧按 ISO 串消费（toDocument / readUpdatedAt），出口统一还原 */
const TIMESTAMP_COLUMNS = ['created_at', 'updated_at'] as const;

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const column of TIMESTAMP_COLUMNS) {
    const value = row[column];
    if (value instanceof Date) row[column] = value.toISOString();
  }
  return row;
}

/**
 * 多条插入：列序与参数序一一对应，参数按行展开，一往返写完一批。
 * 表名与列名都是本模块的常量，值全部走绑定参数。
 */
export function insertRowsSql(table: string, columns: readonly string[], rowCount: number): string {
  const tuples = Array.from(
    { length: rowCount },
    (_, row) =>
      `(${columns.map((_, column) => `$${row * columns.length + column + 1}`).join(', ')})`,
  );
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`;
}

/** 文档行 → 插入参数：updated_at 为空表示「从未编辑」 */
export function toDocumentParams(row: Record<string, unknown>): unknown[] {
  return [
    row.id,
    row.title,
    row.scope,
    row.owner_user_id ?? null,
    row.chunks,
    row.embedding_model,
    row.dim,
    row.created_at,
    row.content,
    row.updated_at ? row.updated_at : null,
  ];
}

/** 向量收敛成普通数组：驱动读回的可能是数组状对象，序列化前统一形状 */
export function toVector(value: unknown): number[] {
  return Array.from(value as ArrayLike<number>);
}

/** 片段行 → 插入参数：向量走 pgvector 文本格式；分片序号由调用方按数组位置给出 */
export function toChunkParams(row: Record<string, unknown>, chunkIndex: number): unknown[] {
  return [
    row.id,
    row.document_id,
    chunkIndex,
    row.title,
    row.content,
    row.scope,
    row.owner_user_id ?? null,
    row.created_at,
    toSql(toVector(row.vector)) ?? '',
  ];
}

/** 检索向量的序列化：与写入侧同一格式，单独导出以免适配器直接依赖 pgvector */
export function toVectorParam(vector: number[]): string {
  return toSql(vector) ?? '';
}
