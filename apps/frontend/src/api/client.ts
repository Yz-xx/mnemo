import type { ApiClient } from '@repo/reusable';
import { createApiClient } from '@repo/reusable';

// localStorage 键名：admin 网站登录令牌的持久化位置
export const TOKEN_KEY = 'admin_token';

/** 令牌失效回调：由 main.ts 经 setSessionExpiredHandler 注入 */
let onSessionExpired: (() => void) | null = null;

/**
 * 注入令牌失效处理：收到 401 时在清本地令牌之外再执行该回调（重置 store、跳登录页）。
 * 跳转策略留在调用方，client 只负责宣布“令牌已失效”，
 * 从而避免在此处引入 router 形成 client → router → store → client 的循环依赖。
 */
export function setSessionExpiredHandler(handler: () => void): void {
  onSessionExpired = handler;
}

/**
 * admin 网站专属 HTTP 客户端：从 localStorage 取 token，401 时清令牌并通知登录失效。
 *
 * baseURL 留空走同源：开发期由 vite proxy 把 /api 转发到 agent-server，
 * 生产期由反向代理统一接入，前端无需感知后端真实地址。
 */
export const adminApi: ApiClient = createApiClient({
  baseURL: '',
  getToken: () => localStorage.getItem(TOKEN_KEY),
  onUnauthorized: () => {
    clearToken();
    onSessionExpired?.();
  },
});

/** 登录成功后写入 token */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** 登出或 401 时清除 token */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 读取当前 token：路由守卫与请求头共用 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
