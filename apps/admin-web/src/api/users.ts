// 用户管理接口：查询、新建、改角色 / 状态、删除与批量操作。
// 统一经 adminApi 发请求，鉴权由请求头里的 Bearer 令牌承担，此处不再重复拼装。
import type { AdminUser, PageResult, UserRole, UserStatus } from './types';
import { encryptPassword } from '@repo/reusable';
import { adminApi } from './client';

/** 用户列表查询条件：keyword 为空表示不做过滤 */
export interface UserQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 用户列表（分页） */
export function listUsers(query: UserQuery): Promise<PageResult<AdminUser>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<AdminUser>>(`/api/admin/users?${params.toString()}`);
}

/** 新建用户：角色由管理端指定；口令同样经服务端公钥加密后再提交 */
export async function createUser(input: {
  username: string;
  password: string;
  role: UserRole;
}): Promise<AdminUser> {
  const encryptedPassword = await encryptPassword(adminApi, input.password);
  const body = { ...input, password: encryptedPassword };
  return adminApi.request<AdminUser>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** 变更角色或状态：只传需要改的字段 */
export function updateUser(
  id: number,
  patch: { role?: UserRole; status?: UserStatus },
): Promise<AdminUser> {
  return adminApi.request<AdminUser>(`/api/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** 删除用户：服务端会连带清理其会话、对话与上传文件 */
export function deleteUser(id: number): Promise<void> {
  return adminApi.request<void>(`/api/admin/users/${id}`, { method: 'DELETE' });
}

// 批量操作统一走一个 POST 接口而不是前端循环调单条，
// 让「整体拒绝」这类跨条目的判定能在一个请求内完成（见 docs/adr/0003）。

/** 批量停用 / 启用用户：返回实际变更的条数 */
export function batchUpdateUserStatus(
  ids: number[],
  status: UserStatus,
): Promise<{ updated: number }> {
  return adminApi.request<{ updated: number }>('/api/admin/users/batch-status', {
    method: 'POST',
    body: JSON.stringify({ ids, status }),
  });
}

/** 批量删除用户：服务端按整批预检，任一项不可删（含当前登录账号、最后一名可登录管理员）则整批拒绝 */
export function batchDeleteUsers(ids: number[]): Promise<void> {
  return adminApi.request<void>('/api/admin/users/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}
