/** 管理端写操作审计实体 */

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
