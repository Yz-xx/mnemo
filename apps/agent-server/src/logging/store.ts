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

/** 批量刷写参数：攒够 batchSize 立即写，否则由 flushIntervalMs 定时写 */
export interface ApiLogFlushOptions {
  batchSize: number;
  flushIntervalMs: number;
  /** 刷写失败的兜底：批量写入已脱离请求上下文，交由装配处记录告警 */
  onError?: (error: unknown) => void;
}

/** 批量 INSERT 的固定列序：行参数拼装顺序必须与它严格一致 */
const INSERT_BATCH = `INSERT INTO api_logs
  (request_id, method, path, status, duration_ms, user_id,
   query_params, request_body, response_body, error, created_at)
 VALUES ?`;

/** 一条日志转为批量 INSERT 的一行参数，顺序与 INSERT_BATCH 的列序一致 */
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
    new Date(),
  ];
}

/**
 * 接口请求日志：由请求日志中间件在响应结束时投递，管理端按路径、方法与状态档位查询。
 * 只追加不修改；写入改批量刷写——先入内存缓冲，攒够一批或定时到点再一次性落库，
 * 把「每请求一条 INSERT」的单轮基线降下来（见 docs/adr/0010 决策 13）。
 * 写入失败不影响已返回的响应，告警由 onError 兜底。
 */
export class ApiLogStore {
  private readonly buffer: ApiLogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** 刷写串行链：停机 flush() 会等上前一次在途刷写，避免 pool 先被关掉、日志没写完 */
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: Pool,
    private readonly options: ApiLogFlushOptions,
  ) {}

  /** 追加一条请求日志：只入内存缓冲，攒够批量或定时到点再落库 */
  record(entry: ApiLogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.options.batchSize) {
      void this.flush();
      return;
    }
    // 定时器 unref：批量刷写不该拖住进程退出；停机时由 flush() 兜底把剩余缓冲落尽
    this.timer ??= setTimeout(() => void this.flush(), this.options.flushIntervalMs).unref();
  }

  /**
   * 批量落库并清空缓冲。停机前 await 它即可确保已入队的日志全部写入——
   * 定时器被 unref 后不会自己触发，这条是「停机落尽」的唯一保证。
   * 写入排在串行链上：既不会与在途刷写并发写同一批，也让停机调用能等到它们收尾。
   */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = this.pending.then(() => this.writeBatch());
    return this.pending;
  }

  /** 取当前缓冲一次性写入；失败只回调 onError，不向上抛（不阻断后续刷写与停机） */
  private async writeBatch(): Promise<void> {
    if (this.buffer.length === 0) return;
    // 先取出再清空：写入期间新到的日志留在缓冲里等下一批，不会被本次误清
    const rows = this.buffer.splice(0, this.buffer.length).map(toRowParams);
    try {
      // 多行 INSERT 走 query：预处理协议不便展开嵌套数组占位符（与 sessionStore.prune 同口径）
      await this.pool.query(INSERT_BATCH, [rows]);
    } catch (error) {
      this.options.onError?.(error);
    }
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
