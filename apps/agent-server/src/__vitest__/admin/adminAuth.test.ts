import type { AppConfig } from '../../configuration/config/index.js';
import type { UserRecord } from '../../entities/user.js';
import type { AdminActor } from '../../infrastructure/auth/actor.js';
import type { SessionStore } from '../../mappers/session.js';
import type { UserStore } from '../../mappers/user/store.js';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { HTTP_STATUS } from '@repo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { createRequireAdmin } from '../../middleware/auth.js';

const ADMIN_TOKEN = 'ops-secret';

/** 假响应：中间件只用到 status / json 与 locals */
class FakeResponse {
  readonly locals: Record<string, unknown> = {};
  statusCode: number = HTTP_STATUS.OK;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.body = payload;
    return this;
  }
}

/** 假请求：本用例只需支持按名取请求头 */
function fakeRequest(headers: Record<string, string> = {}): Request {
  return { get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

function userRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 1,
    username: 'root',
    role: 'admin',
    status: 'active',
    createdAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

interface Scenario {
  headers?: Record<string, string>;
  /** 会话解析出的账号 ID；null 表示令牌无效 */
  userId?: number | null;
  /** 该账号在库中的记录 */
  user?: UserRecord | null;
  /** 配置中的运维超级令牌 */
  adminToken?: string;
}

/** 走一遍中间件：替身隔离数据库，只观察放行与否、状态码与写入的 locals */
async function invoke(scenario: Scenario): Promise<{
  status: number;
  body: unknown;
  admin?: AdminActor;
  nextCalled: boolean;
}> {
  const sessions = {
    resolve: async () => scenario.userId ?? null,
  } as unknown as SessionStore;
  const users = {
    findById: async () => scenario.user ?? null,
  } as unknown as UserStore;
  const config = {
    knowledge: { adminToken: scenario.adminToken ?? ADMIN_TOKEN },
  } as unknown as AppConfig;

  const handler = createRequireAdmin({ sessions, users, config });
  const res = new FakeResponse();
  let nextCalled = false;
  await handler(fakeRequest(scenario.headers), res as unknown as Response, () => {
    nextCalled = true;
  });

  return {
    status: res.statusCode,
    body: res.body,
    admin: res.locals.admin as AdminActor | undefined,
    nextCalled,
  };
}

describe('管理端鉴权', () => {
  it('未携带任何令牌时按未登录返回 401', async () => {
    const result = await invoke({});

    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(result.body).toEqual({ message: ERROR_MESSAGE.SESSION_EXPIRED });
  });

  it('令牌无法解析出账号时同样返回 401', async () => {
    const result = await invoke({ headers: { authorization: 'Bearer stale' }, userId: null });

    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it('已登录但不是管理员时按「资源不存在」返回 404', async () => {
    const result = await invoke({
      headers: { authorization: 'Bearer t-1' },
      userId: 7,
      user: userRecord({ id: 7, role: 'user' }),
    });

    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it('管理员账号被停用时不放行', async () => {
    const result = await invoke({
      headers: { authorization: 'Bearer t-1' },
      userId: 7,
      user: userRecord({ id: 7, status: 'banned' }),
    });

    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it('管理员账号放行，并把账号身份写入 locals 供日志与权限分级取用', async () => {
    const result = await invoke({
      headers: { authorization: 'Bearer t-1' },
      userId: 7,
      user: userRecord({ id: 7 }),
    });

    expect(result.nextCalled).toBe(true);
    expect(result.admin).toEqual({ userId: 7, superToken: false, role: 'admin' });
  });

  it('超级管理员账号同样放行，并把 super_admin 写进 locals', async () => {
    const result = await invoke({
      headers: { authorization: 'Bearer t-1' },
      userId: 7,
      user: userRecord({ id: 7, role: 'super_admin' }),
    });

    expect(result.nextCalled).toBe(true);
    expect(result.admin).toEqual({ userId: 7, superToken: false, role: 'super_admin' });
  });

  it('携带正确的运维超级令牌时放行，且不绑定具体账号', async () => {
    const result = await invoke({ headers: { 'x-admin-token': ADMIN_TOKEN } });

    expect(result.nextCalled).toBe(true);
    // role 为 null 表示不对应具体账号，权限等价超管（见 isSuperAdmin）
    expect(result.admin).toEqual({ userId: null, superToken: true, role: null });
  });

  it('超级令牌不匹配时按未登录处理', async () => {
    const result = await invoke({ headers: { 'x-admin-token': 'wrong' } });

    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it('未配置超级令牌时该请求头不生效，避免空串蒙对', async () => {
    const result = await invoke({ headers: { 'x-admin-token': '' }, adminToken: '' });

    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });
});
