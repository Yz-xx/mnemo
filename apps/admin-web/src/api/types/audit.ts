/** 管理端写操作审计：服务端在写操作结束时自动登记，管理端只读 */
export interface AuditLogItem {
  id: number;
  /** 操作管理员 ID；经运维超级令牌进入时为 null */
  actorId: number | null;
  /** 操作账号名；账号已删除或经超级令牌进入时为 null */
  actorName: string | null;
  method: string;
  path: string;
  status: number;
  /** 请求体摘要，已脱敏并截断 */
  detail: string | null;
  createdAt: string;
}
