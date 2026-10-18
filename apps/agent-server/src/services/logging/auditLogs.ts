import type { AuditLogQuery, AuditLogRecord } from '../../entities/auditLog.js';
import type { AuditLogStore } from '../../mappers/auditLog.js';
import type { UserStore } from '../../mappers/user/store.js';

/** 管理端操作审计检索：只读，写入由审计中间件在管理端写操作结束时完成 */

export interface AuditLogDeps {
  auditLogs: Pick<AuditLogStore, 'list'>;
  users: Pick<UserStore, 'findNamesByIds'>;
}

/** 列表项：审计记录 + 操作账号名；超级令牌入口不对应账号，为 null */
export interface AuditLogListItem extends AuditLogRecord {
  actorName: string | null;
}

/** 列表响应：分页字段原样回传给前端计算总页数 */
export interface AuditLogListResponse {
  items: AuditLogListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 审计列表：按路径包含匹配 + 分页，操作账号名一次批量还原 */
export async function listAuditLogs(
  deps: AuditLogDeps,
  query: AuditLogQuery,
): Promise<AuditLogListResponse> {
  const { items, total } = await deps.auditLogs.list(query);
  // 超级令牌入口没有账号 ID，先从集合里剔除再批量查名，避免让 IN 落进一个 NULL
  const actorIds = items.map((item) => item.actorId).filter((id): id is number => id !== null);
  const names = await deps.users.findNamesByIds(actorIds);
  return {
    items: items.map((item) => ({
      ...item,
      actorName: item.actorId === null ? null : (names.get(item.actorId) ?? null),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}
