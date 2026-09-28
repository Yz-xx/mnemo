import type { AuthSession, AuthUser } from './types';
import { adminApi } from './client';

/** 登录：成功返回 token 与用户信息，由 store 落盘 localStorage */
export function login(username: string, password: string): Promise<AuthSession> {
  return adminApi.request<AuthSession>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
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
