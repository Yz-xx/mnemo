import type { PoolClient } from 'pg';
import { toSql } from 'pgvector';
import { CHUNKS_TABLE, DOCUMENTS_TABLE, VECTOR_INDEX, toVector } from './pg.js';

/**
 * 片段表与向量索引的 PostgreSQL 方言（见 docs/adr/0012）：
 * 列序、DDL、存量补列、索引、检索 SQL 与片段参数都收在这里。
 * 文档表方言见 pgDocuments.ts，表名与会话参数见 pg.ts。
 */

/** 片段表列序：向量列叫 embedding，写入时序列化成 pgvector 文本格式（见 toChunkParams） */
export const CHUNK_COLUMNS = [
  'id',
  'document_id',
  'knowledge_base_id',
  'chunk_index',
  'title',
  'content',
  'page',
  'created_at',
  'embedding',
] as const;

/**
 * 片段表 DDL：向量维度在建表时固定，而 vector(N) 的 N 不能占位参数化，
 * 因此按「首个向量维度」拼入，拼前先做正整数白名单校验（无注入面）。
 * chunk_index 记录片段在同一文档内的原始次序：旧文档按分片拼正文必须有个稳定序（见 stitchChunks）。
 * page 记录片段所在原始文件页码；文本来源与旧数据为 NULL，不代表第 0 页。
 */
export function createChunksSql(dim: number): string {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`向量维度非法：${dim}`);
  return `
CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES ${DOCUMENTS_TABLE} (id) ON DELETE CASCADE,
  knowledge_base_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  page integer NULL,
  created_at timestamptz(3) NOT NULL,
  embedding vector(${dim}) NOT NULL
)`.trim();
}

/** 存量片段表补列：CREATE TABLE IF NOT EXISTS 不会给已有表加列，启动时幂等补一遍 */
export const ADD_CHUNK_COLUMNS_SQL = `ALTER TABLE IF EXISTS ${CHUNKS_TABLE} ADD COLUMN IF NOT EXISTS page integer NULL`;

/** 片段表的常规索引：库过滤（检索）与按文档拼正文 / 级联删除各用到一条，IF NOT EXISTS 幂等 */
export const CREATE_CHUNK_INDEXES_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_chunks_base ON ${CHUNKS_TABLE} (knowledge_base_id)`,
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

export const COUNT_CHUNKS_SQL = `SELECT COUNT(*) AS count FROM ${CHUNKS_TABLE}`;
export const STITCH_CHUNKS_SQL = `SELECT content FROM ${CHUNKS_TABLE} WHERE document_id = $1 ORDER BY chunk_index`;
/**
 * 检索 SQL：score 取 1 - 余弦距离，与 minScore 阈值同口径。
 * 库 id 清单由服务层检索前预解析（$2，数组绑定参数），HNSW 扫描中不做 join（docs/adr/0018 决策 4）；
 * 片段 id 与页码一并返回，引用协议据此定位预览（迭代 3 T3.2）。
 */
export const SEARCH_CHUNKS_SQL = `
SELECT id, document_id, title, content, page, 1 - (embedding <=> $1) AS score
FROM ${CHUNKS_TABLE}
WHERE knowledge_base_id = ANY($2)
ORDER BY embedding <=> $1
LIMIT $3`.trim();

/** 片段行 → 插入参数：向量走 pgvector 文本格式；分片序号由调用方按数组位置给出 */
export function toChunkParams(row: Record<string, unknown>, chunkIndex: number): unknown[] {
  return [
    row.id,
    row.document_id,
    row.knowledge_base_id,
    chunkIndex,
    row.title,
    row.content,
    row.page ?? null,
    row.created_at,
    toSql(toVector(row.vector)) ?? '',
  ];
}
