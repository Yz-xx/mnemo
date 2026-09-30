import type { AuthSession, AuthUser } from '@/api/types';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { login as apiLogin, logout as apiLogout, fetchCurrentUser } from '@/api/auth';
import { TOKEN_KEY } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { installMemoryStorage } from './storageStub';

// 登录态 store 的职责是「守门 + 落令牌 + 清态」，网络调用本身不属于本模块，全部替身化
vi.mock('@/api/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  fetchCurrentUser: vi.fn(),
}));

const ADMIN: AuthUser = { id: 1, username: 'root', role: 'admin', status: 'active' };

/** 造一个成功登录响应：默认是管理员，非管理员场景由各用例覆盖 user */
function sessionOf(user: AuthUser, token = 'token-abc'): AuthSession {
  return { token, user };
}

describe('登录态 store', () => {
  beforeEach(() => {
    // 先卸掉上一条用例遗留的全局替身，再装一份干净的内存存储
    vi.unstubAllGlobals();
    installMemoryStorage();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('管理员登录成功后写入令牌并填充用户信息', async () => {
    vi.mocked(apiLogin).mockResolvedValue(sessionOf(ADMIN, 'token-admin'));
    const auth = useAuthStore();

    await auth.login('root', 'pw');

    expect(auth.token).toBe('token-admin');
    expect(auth.user).toEqual(ADMIN);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('token-admin');
  });

  it('超级管理员同样放行：后台侧角色不止 admin 一个', async () => {
    const superAdmin: AuthUser = { id: 3, username: 'ops', role: 'super_admin', status: 'active' };
    vi.mocked(apiLogin).mockResolvedValue(sessionOf(superAdmin, 'token-super'));
    const auth = useAuthStore();

    await auth.login('ops', 'pw');

    expect(auth.token).toBe('token-super');
    expect(auth.user).toEqual(superAdmin);
  });

  it('普通账号即便密码正确也当场拒绝，且不落任何令牌', async () => {
    vi.mocked(apiLogin).mockResolvedValue(
      sessionOf({ id: 2, username: 'tom', role: 'user', status: 'active' }),
    );
    const auth = useAuthStore();

    await expect(auth.login('tom', 'pw')).rejects.toThrow('该账号没有管理后台权限');

    // 落了令牌就会被守卫放行，用户看到的是「登录成功又被踢出来」，故此处必须为空
    expect(auth.token).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('被停用的管理员同样拒绝登录', async () => {
    vi.mocked(apiLogin).mockResolvedValue(
      sessionOf({ id: 1, username: 'root', role: 'admin', status: 'banned' }),
    );
    const auth = useAuthStore();

    await expect(auth.login('root', 'pw')).rejects.toThrow('该账号没有管理后台权限');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('本地没有令牌时不发 /me 请求', async () => {
    const auth = useAuthStore();

    await auth.restoreUser();

    expect(fetchCurrentUser).not.toHaveBeenCalled();
  });

  it('并发调用恢复登录态时复用同一次 /me 请求，不重复拉取', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-admin');
    let resolveMe: ((user: AuthUser) => void) | undefined;
    vi.mocked(fetchCurrentUser).mockReturnValue(
      new Promise<AuthUser>((resolve) => {
        resolveMe = resolve;
      }),
    );

    const auth = useAuthStore();
    // 启动流程与路由守卫可能同时要求恢复，两次调用应共享同一个在途请求
    const first = auth.restoreUser();
    const second = auth.restoreUser();

    expect(fetchCurrentUser).toHaveBeenCalledTimes(1);

    resolveMe?.(ADMIN);
    await Promise.all([first, second]);

    expect(auth.user?.username).toBe('root');
  });

  it('恢复登录态失败时清空本地令牌与用户', async () => {
    localStorage.setItem(TOKEN_KEY, 'stale-token');
    vi.mocked(fetchCurrentUser).mockRejectedValue(new Error('登录已失效'));
    const auth = useAuthStore();

    await auth.restoreUser();

    expect(auth.user).toBeNull();
    expect(auth.token).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('登出时即便服务端调用失败也要清掉本地态', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-admin');
    vi.mocked(apiLogout).mockRejectedValue(new Error('网络不通'));
    const auth = useAuthStore();

    await expect(auth.logout()).rejects.toThrow('网络不通');

    expect(auth.token).toBeNull();
    expect(auth.user).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
