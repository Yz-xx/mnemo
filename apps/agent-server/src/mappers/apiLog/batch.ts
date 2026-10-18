import type { ApiLogEntry } from '../../entities/apiLog.js';
import type { DbPool } from '../../infrastructure/db/pool.js';

/** 批量刷写参数：攒够 batchSize 立即写，否则由 flushIntervalMs 定时写 */
export interface ApiLogFlushOptions {
  batchSize: number;
  flushIntervalMs: number;
  /** 刷写失败的兜底：批量写入已脱离请求上下文，交由装配处记录告警 */
  onError?: (error: unknown) => void;
}

/** 批量 INSERT 的固定列序：行参数拼装顺序必须与它严格一致 */
const INSERT_COLUMNS = [
  'request_id',
  'method',
  'path',
  'status',
  'duration_ms',
  'user_id',
  'query_params',
  'request_body',
  'response_body',
  'error',
  'created_at',
] as const;

/**
 * 按行数展开占位符：MySQL 的 `VALUES ?` 整块展开在 PG 没有对应写法，
 * 改成逐行逐列拼 `$1..$n`——列名是本模块常量，值仍全部走绑定参数。
 */
function insertBatchSql(rowCount: number): string {
  const tuples = Array.from(
    { length: rowCount },
    (_, row) =>
      `(${INSERT_COLUMNS.map((_, col) => `$${row * INSERT_COLUMNS.length + col + 1}`).join(', ')})`,
  );
  return `INSERT INTO api_logs (${INSERT_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`;
}

/** 一条日志转为批量 INSERT 的一行参数，顺序与 INSERT_COLUMNS 一致 */
function toRowParams(entry: ApiLogEntry): (string | number | Date | null)[] {
  return [
    entry.requestId,
    entry.method,
    entry.path,
    entry.status,
    entry.durationMs,
    entry.userId,
    entry.queryParams,
    entry.requestBody,
    entry.responseBody,
    entry.error,
    // 用条目自带的调用时刻：刷写是批量延迟写，此刻的 new Date() 是写入时间而非调用时间
    entry.createdAt,
  ];
}

/**
 * 一批日志一次写入：参数按行展开后交给单条 INSERT。
 * 失败向上抛，由调用方决定告警口径（批写已脱离请求上下文，不能回推给客户端）。
 */
export async function writeApiLogBatch(pool: DbPool, entries: ApiLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const params = entries.map(toRowParams);
  await pool.query(insertBatchSql(params.length), params.flat());
}
