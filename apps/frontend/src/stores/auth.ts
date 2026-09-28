import type { AuthUser } from '@/api/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { login as apiLogin, logout as apiLogout, fetchCurrentUser } from '@/api/auth';
import { clearToken, getToken, setToken } from '@/api/client';

/**
 * 登录态 store：token 与当前用户信息。
 * token 落 localStorage（adminApi 每次请求实时读取），user 信息在内存中，
 * 刷新页面后由 restoreUser 重新拉取。
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null);
  const token = ref<string | null>(getToken());
  /** 进行中的 /me 请求：启动流程与路由守卫可能同时需要，复用同一份 Promise 避免重复拉取 */
  let pending: Promise<void> | null = null;

  /** 登录：成功后落盘 token 并填充用户信息；非管理员当场拒绝，不留令牌 */
  async function login(username: string, password: string): Promise<void> {
    const session = await apiLogin(username, password);
    if (session.user.role !== 'admin' || session.user.status !== 'active') {
      // 后台只服务管理员：普通账号即便密码正确也不写入令牌，否则会被守卫放行后再弹回登录页
      throw new Error('该账号没有管理后台权限');
    }
    setToken(session.token);
    token.value = session.token;
    user.value = session.user;
  }

  /** 清本地登录态：登出、令牌失效（401）与 /me 拉取失败共用同一处收口 */
  function clear(): void {
    clearToken();
    token.value = null;
    user.value = null;
  }

  /** 刷新页面后恢复用户信息：token 存在则拉 /me，失败则清态 */
  async function restoreUser(): Promise<void> {
    if (!token.value) return;
    pending ??= (async () => {
      try {
        user.value = await fetchCurrentUser();
      } catch {
        clear();
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  /** 登出：尽力调服务端清 session，无论成败都清本地态 */
  async function logout(): Promise<void> {
    try {
      await apiLogout();
    } finally {
      clear();
    }
  }

  return { user, token, login, restoreUser, logout, clear };
});
