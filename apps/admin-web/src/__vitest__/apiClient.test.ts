import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminApi,
  clearToken,
  getToken,
  setSessionExpiredHandler,
  setToken,
  TOKEN_KEY,
} from '@/api/client';
import { installMemoryStorage } from './storageStub';

/**
 * 用真实 Response 顶替 fetch：错误归一化依赖 res.ok 与 res.json()，手写假对象容易与运行时行为脱节。
 * 返回替身本身，供需要检查请求参数的用例断言。
 */
function stubFetch(status: number, body: unknown) {
  const mock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('后台 HTTP 客户端的令牌与失效收口', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installMemoryStorage();
    vi.clearAllMocks();
    // 失效回调是模块级状态、跨用例留存，先换成空实现，免得被下一条用例意外触发
    setSessionExpiredHandler(() => {});
  });

  it('写入令牌后能原样读回', () => {
    setToken('token-admin');
    expect(getToken()).toBe('token-admin');
  });

  it('清除令牌后读不到', () => {
    setToken('token-admin');
    clearToken();
    expect(getToken()).toBeNull();
  });

  it('发起请求时把当前令牌拼进 Authorization 头', async () => {
    setToken('token-admin');
    const fetchMock = stubFetch(200, { items: [] });

    await adminApi.request('/api/admin/users');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/users',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-admin' }),
      }),
    );
  });

  it('收到 401 时清掉本地令牌并通知调用方登录失效', async () => {
    setToken('token-admin');
    const onExpired = vi.fn();
    setSessionExpiredHandler(onExpired);
    stubFetch(401, { message: '登录已失效，请重新登录' });

    await expect(adminApi.request('/api/admin/users')).rejects.toThrow('登录已失效，请重新登录');

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('服务端 500 时保留令牌，也不通知登录失效', async () => {
    setToken('token-admin');
    const onExpired = vi.fn();
    setSessionExpiredHandler(onExpired);
    stubFetch(500, { message: '服务内部错误' });

    await expect(adminApi.request('/api/admin/users')).rejects.toThrow('服务内部错误');

    // 500 不是登录问题，把用户踢回登录页只会让人白丢一次操作
    expect(localStorage.getItem(TOKEN_KEY)).toBe('token-admin');
    expect(onExpired).not.toHaveBeenCalled();
  });
});
