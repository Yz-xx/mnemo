import type { Pool, RowDataPacket } from 'mysql2/promise';

/** 状态档位：all 不限，client 只看 4xx，server 只看 5xx */
export type ApiLogStatusKind = 'all' | 'client' | 'server';

/** 一条请求日志：与请求日志中间件在响应结束时汇总的字段一一对应 */
export interface ApiLogEntry {
  /** 8 位请求 ID，与响应头 x-request-id 一致 */
  requestId: string;
  method: string;
  /** 不含查询串的路径 */
  path: string;
  status: number;
  durationMs: number;
  /** 登录用户 ID；未登录与运维超级令牌入口为 null */
  userId: number | null;
  queryParams: string | null;
  requestBody: string | null;
  responseBody: string | null;
  /** 错误摘要，仅 5xx 有值 */
  error: string | null;
}

/** 列表项：多一个自增序号，前端据此做行标识，排序也复用它 */
export interface ApiLogRecord extends ApiLogEntry {
  id: number;
  createdAt: string;
}

/** 列表查询条件：keyword 按路径包含匹配，method 为空串或状态档位为 all 表示不限 */
export interface ApiLogQuery {
  keyword: string;
  method: string;
  statusKind: ApiLogStatusKind;
  page: number;
  pageSize: number;
}

/** 分页结果：total 为满足条件的总数，供前端计算总页数 */
export interface ApiLogPage {
  items: ApiLogRecord[];
  total: number;
}

interface ApiLogRow extends RowDataPacket {
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

interface CountRow extends RowDataPacket {
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
 * 组装列表查询的 WHERE 子句与参数：参数顺序必须与占位符出现顺序严格一致，
 * 单独成函数是为了让这份对应关系能被直接测到——错位不会报错，只会静默查出错误结果。
 */
export function buildFilters(
  query: Pick<ApiLogQuery, 'keyword' | 'method' | 'statusKind'>,
): ApiLogFilters {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (query.keyword) {
    // LOCATE 免去对 % / _ 的转义，与用户列表的匹配口径保持一致
    clauses.push('LOCATE(?, path) > 0');
    params.push(query.keyword);
  }
  if (query.method) {
    clauses.push('method = ?');
    params.push(query.method);
  }
  if (query.statusKind !== 'all') {
    clauses.push(STATUS_RANGE[query.statusKind]);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

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

/**
 * 接口请求日志：由请求日志中间件在响应结束时投递，管理端按路径、方法与状态档位查询。
 * 只追加不修改；写入失败由调用方吞掉——记日志失败不该影响已经返回的响应。
 */
export class ApiLogStore {
  constructor(private readonly pool: Pool) {}

  /** 追加一条请求日志 */
  async record(entry: ApiLogEntry): Promise<void> {
    await this.pool.execute(
      `INSERT INTO api_logs
        (request_id, method, path, status, duration_ms, user_id,
         query_params, request_body, response_body, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        new Date(),
      ],
    );
  }

  /** 管理端列表：按条件过滤 + 分页；按序号倒序，等价于时间倒序且走主键索引 */
  async list(query: ApiLogQuery): Promise<ApiLogPage> {
    const { where, params } = buildFilters(query);
    const [countRows] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM api_logs ${where}`,
      params,
    );
    const [rows] = await this.pool.execute<ApiLogRow[]>(
      `SELECT ${LOG_COLUMNS} FROM api_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    );
    return { items: rows.map(toRecord), total: Number(countRows[0]?.total ?? 0) };
  }
}
