// 上传文件管理接口：列表、删除与批量删除（管理视角，含全部用户的文件）。
// 统一经 adminApi 发请求，鉴权由请求头里的 Bearer 令牌承担，此处不再重复拼装。
import type { AdminFileItem, PageResult } from './types';
import { adminApi } from './client';

/** 文件列表查询条件：keyword 按文件名包含匹配 */
export interface FileQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 文件列表：管理视角，含全部用户的上传文件与归属账号名 */
export function listAdminFiles(query: FileQuery): Promise<PageResult<AdminFileItem>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<AdminFileItem>>(`/api/admin/files?${params.toString()}`);
}

/** 删除文件：元数据与落盘字节一并清理 */
export function deleteAdminFile(id: string): Promise<void> {
  return adminApi.request<void>(`/api/admin/files/${id}`, { method: 'DELETE' });
}

// 批量操作统一走一个 POST 接口而不是前端循环调单条，
// 让「整体拒绝」这类跨条目的判定能在一个请求内完成（见 docs/adr/0003）。

/** 批量删除文件：元数据与落盘字节一并清理，不存在的条目视为已完成 */
export function batchDeleteAdminFiles(ids: string[]): Promise<void> {
  return adminApi.request<void>('/api/admin/files/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}
