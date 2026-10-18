import type {
  ApiLogPage,
  ApiLogQuery,
  ApiLogRecord,
  ApiLogStatusKind,
} from '../../entities/apiLog.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import type { QueryResultRow } from 'pg';

interface ApiLogRow extends QueryResultRow {
  id: number;
  request_id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  user_id: number | null;
  query_params: string | null;
  request_body: string | null;
  response_body: string | null;
  error: string | null;
  created_at: Date;
}

interface CountRow extends QueryResultRow {
  total: number;
}

/** 列集合显式列出：不用 SELECT *，以免补列后行对象的键悄悄变化 */
const LOG_COLUMNS = `id, request_id, method, path, status, duration_ms, user_id,
  query_params, request_body, response_body, error, created_at`;

/** 状态档位对应的区间条件：用区间而非具体码，将来出现 503 之类不必改前端 */
const STATUS_RANGE: Record<Exclude<ApiLogStatusKind, 'all'>, string> = {
  client: 'status >= 400 AND status < 500',
  server: 'status >= 500',
};

/** 过滤条件：子句片段全是代码内的字面量，取值一律走占位符 */
export interface ApiLogFilters {
  where: string;
  params: (string | number)[];
}

/**
 * 组装列表查询的 WHERE 子句与参数：占位符序号按参数入列顺序递增，
 * 单独成函数是为了让这份对应关系能被直接测到——错位不会报错，只会静默查出错误结果。
 */
export function buildFilters(
  query: Pick<ApiLogQuery, 'keyword' | 'method' | 'statusKind'>,
): ApiLogFilters {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (query.keyword) {
    // strpos 免去对 % / _ 的转义，与用户列表的匹配口径保持一致
    params.push(query.keyword);
    clauses.push(`strpos(path, $${params.length}) > 0`);
  }
  if (query.method) {
    params.push(query.method);
    clauses.push(`method = $${params.length}`);
  }
  if (query.statusKind !== 'all') {
    clauses.push(STATUS_RANGE[query.statusKind]);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** 行转接口日志记录：蛇形列名映射为驼峰字段，数字列与时间列在此收敛类型 */
function toRecord(row: ApiLogRow): ApiLogRecord {
  return {
    id: Number(row.id),
    requestId: row.request_id,
    method: row.method,
    path: row.path,
    status: Number(row.status),
    durationMs: Number(row.duration_ms),
    userId: row.user_id === null ? null : Number(row.user_id),
    queryParams: row.query_params,
    requestBody: row.request_body,
    responseBody: row.response_body,
    error: row.error,
    createdAt: row.created_at.toISOString(),
  };
}

/** 管理端列表：按条件过滤 + 分页；按序号倒序，等价于时间倒序且走主键索引 */
export async function listApiLogs(pool: DbPool, query: ApiLogQuery): Promise<ApiLogPage> {
  const { where, params } = buildFilters(query);
  const { rows: countRows } = await pool.query<CountRow>(
    `SELECT COUNT(*) AS total FROM api_logs ${where}`,
    params,
  );
  const { rows } = await pool.query<ApiLogRow>(
    `SELECT ${LOG_COLUMNS} FROM api_logs ${where} ORDER BY id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return { items: rows.map(toRecord), total: Number(countRows[0]?.total ?? 0) };
}
