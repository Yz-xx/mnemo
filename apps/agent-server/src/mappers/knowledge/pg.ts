import { toSql } from 'pgvector';

/**
 * 知识库向量存储的 PostgreSQL 方言层公共部分（见 docs/adr/0012）。
 * 表名、会话级检索参数与行参数通用工具收在这里：
 * 文档表方言见 pgDocuments.ts，片段表与向量索引见 pgChunks.ts。
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

/** 向量收敛成普通数组：驱动读回的可能是数组状对象，序列化前统一形状 */
export function toVector(value: unknown): number[] {
  return Array.from(value as ArrayLike<number>);
}

/** 检索向量的序列化：与写入侧同一格式，单独导出以免适配器直接依赖 pgvector */
export function toVectorParam(vector: number[]): string {
  return toSql(vector) ?? '';
}
