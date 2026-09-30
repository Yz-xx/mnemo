// 操作审计接口：只记管理端写操作，由服务端自动登记，管理端只读。
// 统一经 adminApi 发请求，鉴权由请求头里的 Bearer 令牌承担，此处不再重复拼装。
import type { AuditLogItem, PageResult } from './types';
import { adminApi } from './client';

/** 审计查询条件：keyword 按请求路径包含匹配 */
export interface AuditQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 操作审计列表：只记管理端写操作，由服务端自动登记，此处只读 */
export function listAuditLogs(query: AuditQuery): Promise<PageResult<AuditLogItem>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<AuditLogItem>>(`/api/admin/audit?${params.toString()}`);
}
