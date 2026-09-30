import type { AuthSession, AuthUser } from './types';
import { encryptPassword } from '@repo/reusable';
import { adminApi } from './client';

/**
 * 登录：口令先经服务端公钥加密再提交，成功返回 token 与用户信息，由 store 落盘 localStorage。
 * 后台有独立入口（见 docs/adr/0006）：端由路径承载，客户端账号走 /api/auth/login，此处只接受后台账号。
 */
export async function login(username: string, password: string): Promise<AuthSession> {
  const encryptedPassword = await encryptPassword(adminApi, password);
  return adminApi.request<AuthSession>('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password: encryptedPassword }),
  });
}

/** 当前用户信息：路由守卫与初始化时拉取以恢复登录态 */
export function fetchCurrentUser(): Promise<AuthUser> {
  return adminApi.request<AuthUser>('/api/auth/me');
}

/** 登出：服务端清 session；客户端清 localStorage 由 store 处理 */
export function logout(): Promise<void> {
  return adminApi.request<void>('/api/auth/logout', { method: 'POST' });
}
