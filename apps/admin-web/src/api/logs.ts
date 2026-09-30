// 接口请求日志接口：由服务端在响应结束时自动落库，管理端只读。
// 统一经 adminApi 发请求，鉴权由请求头里的 Bearer 令牌承担，此处不再重复拼装。
import type { ApiLogItem, ApiLogStatusKind, PageResult } from './types';
import { adminApi } from './client';

/** 接口日志查询条件：method 为空串、status 为 all 时表示不做该维度过滤 */
export interface ApiLogQuery {
  keyword: string;
  method: string;
  status: ApiLogStatusKind;
  page: number;
  pageSize: number;
}

/** 接口日志列表：日志由服务端自动采集，此处只读 */
export function listApiLogs(query: ApiLogQuery): Promise<PageResult<ApiLogItem>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    method: query.method,
    status: query.status,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<ApiLogItem>>(`/api/admin/logs?${params.toString()}`);
}
