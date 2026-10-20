import type { AppDependencies } from '../../configuration/dependencies.js';
import type { HttpClient } from '@mnemo/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptPassword, HTTP_STATUS } from '@mnemo/reusable';
import { createHttpClient } from '@mnemo/shared';
import { createAdminAuthRouter } from '../../controllers/admin/auth.js';
import { createPasswordCipher } from '../../infrastructure/auth/passwordCipher.js';

/**
 * 后台登录入口的端到端回归。
 * 它比客户端入口只多一道「必须是后台侧角色」的判定（见 docs/adr/0006），
 * 两种失败提示的分工也钉在这里：口令不对时含糊，口令通过而端不匹配时明确。
 */

const ADMIN_USERNAME = 'ops';
const USER_USERNAME = 'bxzhuo';
const PASSWORD = 'secret123';

const fakeUsers = {
  // 两个账号共用同一口令，只有角色不同：用来验证端隔离只认角色、不看口令
  authenticate: async (username: string, password: string) => {
    if (password !== PASSWORD) return null;
    if (username !== ADMIN_USERNAME && username !== USER_USERNAME) return null;
    return {
      id: 1,
      username,
      role: username === ADMIN_USERNAME ? 'super_admin' : 'user',
      status: 'active',
      createdAt: '2026-09-30T00:00:00.000Z',
    };
  },
};

const fakeSessions = { create: async () => 'token-1' };

const passwordCipher = createPasswordCipher();

const app = express();
app.use(express.json());
// 真实应用中 requestLogger 来自 requestLog 中间件；这里补一个最小替身，避免路由里的日志调用抛错
app.use((_req, res, next) => {
  res.locals.log = { info: () => {}, warn: () => {}, error: () => {} };
  next();
});
// 公钥由客户端入口下发（两端共用 /api/auth/public-key），本文件只挂后台登录，故补齐这一段
app.get('/api/auth/public-key', (_req, res) => {
  res.json({ publicKey: passwordCipher.publicKey() });
});
app.use(
  '/api/admin/auth',
  createAdminAuthRouter({
    users: fakeUsers as unknown as AppDependencies['users'],
    sessions: fakeSessions as unknown as AppDependencies['sessions'],
    passwordCipher,
  }),
);

let server: Server;
let baseUrl = '';
let api: HttpClient;

/** 登录请求：password 传什么就发什么，用来对比密文与明文的待遇 */
function login(username: string, password: string): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  api = createHttpClient({ baseURL: baseUrl });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('后台登录入口', () => {
  it('后台账号用加密口令登录成功', async () => {
    const password = await encryptPassword(api, PASSWORD);
    const response = await login(ADMIN_USERNAME, password);

    expect(response.status).toBe(HTTP_STATUS.OK);
    await expect(response.json()).resolves.toMatchObject({
      token: 'token-1',
      user: { username: ADMIN_USERNAME, role: 'super_admin' },
    });
  });

  it('客户端账号不能登录后台：口令没错，故明确提示改用客户端', async () => {
    const password = await encryptPassword(api, PASSWORD);
    const response = await login(USER_USERNAME, password);

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    await expect(response.json()).resolves.toEqual({
      message: '该账号不能登录管理后台，请使用客户端',
    });
  });

  it('口令错误时沿用含糊提示，不暴露账号是否已注册', async () => {
    const password = await encryptPassword(api, 'wrong-password');
    const response = await login(ADMIN_USERNAME, password);

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    await expect(response.json()).resolves.toEqual({ message: '用户名或密码错误' });
  });

  it('明文口令被拒：加密不是可选项', async () => {
    expect((await login(ADMIN_USERNAME, PASSWORD)).status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});
