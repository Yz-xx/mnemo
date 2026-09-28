import type { Pool, RowDataPacket } from 'mysql2/promise';

/** 一条审计记录：由审计中间件在写操作响应结束时投递 */
export interface AuditLogEntry {
  /** 操作管理员 ID；经运维超级令牌进入时为 null，不对应具体账号 */
  actorId: number | null;
  method: string;
  /** 不含查询串的路径，被改动的资源即包含在其中（如 /api/admin/users/12） */
  path: string;
  /** 响应状态码：失败的写入尝试同样留档，便于回溯越权与误操作 */
  status: number;
  /** 请求体摘要，已脱敏并截断 */
  detail: string | null;
}

/** 列表项：多一个自增序号，前端据此做行标识，排序也复用它 */
export interface AuditLogRecord extends AuditLogEntry {
  id: number;
  createdAt: string;
}

/** 列表查询条件：keyword 按路径包含匹配 */
export interface AuditLogQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 分页结果：total 为满足条件的总数，供前端计算总页数 */
export interface AuditLogPage {
  items: AuditLogRecord[];
  total: number;
}

interface AuditLogRow extends RowDataPacket {
  id: number;
  actor_id: number | null;
  method: string;
  path: string;
  status: number;
  detail: string | null;
  created_at: Date;
}

interface CountRow extends RowDataPacket {
  total: number;
}

/** 列集合显式列出：不用 SELECT *，以免补列后行对象的键悄悄变化 */
const LOG_COLUMNS = 'id, actor_id, method, path, status, detail, created_at';

function toRecord(row: AuditLogRow): AuditLogRecord {
  return {
    id: Number(row.id),
    actorId: row.actor_id === null ? null : Number(row.actor_id),
    method: row.method,
    path: row.path,
    status: Number(row.status),
    detail: row.detail,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 管理端写操作审计：由审计中间件投递，管理端按路径检索。
 * 与接口日志的分工是「范围」而非「内容」——这里只留管理端的写入动作及其操作人，
 * 不记读操作与普通用户请求，运维回溯变更时不必在一堆 GET 里翻找。
 * 只追加不修改；写入失败由调用方吞掉——记审计失败不该影响已经返回的响应。
 */
export class AuditLogStore {
  constructor(private readonly pool: Pool) {}

  /** 追加一条审计记录 */
  async record(entry: AuditLogEntry): Promise<void> {
    await this.pool.execute(
      `INSERT INTO audit_logs (actor_id, method, path, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.actorId, entry.method, entry.path, entry.status, entry.detail, new Date()],
    );
  }

  /** 管理端列表：按路径关键词过滤 + 分页；按序号倒序，等价于时间倒序且走主键索引 */
  async list(query: AuditLogQuery): Promise<AuditLogPage> {
    const { keyword, page, pageSize } = query;
    // 无关键词时不拼 WHERE：与用户列表、文档列表的过滤口径一致
    const where = keyword ? 'WHERE LOCATE(?, path) > 0' : '';
    const params = keyword ? [keyword] : [];
    const [countRows] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM audit_logs ${where}`,
      params,
    );
    const [rows] = await this.pool.execute<AuditLogRow[]>(
      `SELECT ${LOG_COLUMNS} FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return { items: rows.map(toRecord), total: Number(countRows[0]?.total ?? 0) };
  }
}
