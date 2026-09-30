import type { AuthUser } from '@/api/types';
import type { Router } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCurrentUser } from '@/api/auth';
import { TOKEN_KEY } from '@/api/client';
import { installGuards } from '@/router/guards';
import { useAuthStore } from '@/stores/auth';
import { installMemoryStorage } from './storageStub';

vi.mock('@/api/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  fetchCurrentUser: vi.fn(),
}));

const ADMIN: AuthUser = { id: 1, username: 'root', role: 'admin', status: 'active' };
const NORMAL_USER: AuthUser = { id: 2, username: 'tom', role: 'user', status: 'active' };

/** 守卫只读 to 的 path 与 fullPath，这里按用到的字段造最小导航目标 */
interface GuardTarget {
  path: string;
  fullPath: string;
}

type NavigationGuard = (to: GuardTarget) => Promise<unknown>;

/** 守卫的接缝就是注册进路由的那个导航函数：伪造一个只负责接住它的路由对象即可 */
function captureGuard(): NavigationGuard {
  const captured: NavigationGuard[] = [];
  const fakeRouter = {
    beforeEach: (fn: NavigationGuard) => {
      captured.push(fn);
    },
  } as unknown as Router;

  installGuards(fakeRouter);
  return captured[0];
}

describe('路由守卫的登录态与角色双校验', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installMemoryStorage();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('登录页自身直接放行，避免无限重定向', async () => {
    const guard = captureGuard();

    expect(await guard({ path: '/login', fullPath: '/login' })).toBe(true);
  });

  it('本地没有令牌时带原路径回登录页', async () => {
    const guard = captureGuard();

    expect(await guard({ path: '/users', fullPath: '/users?page=2' })).toEqual({
      path: '/login',
      query: { redirect: '/users?page=2' },
    });
  });

  it('刷新页面后先拉取用户信息再判角色，管理员不被误踢回登录页', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-admin');
    vi.mocked(fetchCurrentUser).mockResolvedValue(ADMIN);

    const auth = useAuthStore();
    // 刷新后 store 里的用户信息是空的，这一步是复现真实时序的关键
    expect(auth.user).toBeNull();

    const guard = captureGuard();

    expect(await guard({ path: '/users', fullPath: '/users' })).toBe(true);
    expect(fetchCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('已恢复登录态的管理员直接放行，不重复拉取用户信息', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-admin');
    vi.mocked(fetchCurrentUser).mockResolvedValue(ADMIN);

    const auth = useAuthStore();
    await auth.restoreUser();

    const guard = captureGuard();

    expect(await guard({ path: '/users', fullPath: '/users' })).toBe(true);
    expect(fetchCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('普通账号一律回登录页，后台没有面向普通账号的页面', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-user');
    vi.mocked(fetchCurrentUser).mockResolvedValue(NORMAL_USER);

    const auth = useAuthStore();
    await auth.restoreUser();

    const guard = captureGuard();

    expect(await guard({ path: '/users', fullPath: '/users' })).toEqual({ path: '/login' });
  });

  it('恢复用户信息失败时回登录页', async () => {
    localStorage.setItem(TOKEN_KEY, 'stale-token');
    vi.mocked(fetchCurrentUser).mockRejectedValue(new Error('登录已失效'));

    const guard = captureGuard();

    expect(await guard({ path: '/users', fullPath: '/users' })).toEqual({ path: '/login' });
  });
});
