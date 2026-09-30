// 总览与运行状态接口。
// 统一经 adminApi 发请求，鉴权由请求头里的 Bearer 令牌承担，此处不再重复拼装。
import type { AdminHealth, AdminStats } from './types';
import { adminApi } from './client';

/** 总览统计 */
export function fetchStats(): Promise<AdminStats> {
  return adminApi.request<AdminStats>('/api/admin/stats');
}

/** 运行状态 */
export function fetchHealth(): Promise<AdminHealth> {
  return adminApi.request<AdminHealth>('/api/admin/health');
}
