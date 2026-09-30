import type { AppDependencies } from '../configuration/dependencies.js';
import type { ApiClient } from '@repo/reusable';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient, encryptPassword, HTTP_STATUS } from '@repo/reusable';
import { createPasswordCipher } from '../auth/passwordCipher.js';
import { createAuthRouter } from '../routes/client/auth.js';

/**
 * 登录口令传输的端到端回归。
 * 客户端加密与服务端解密各自单测通过，不代表两者拼起来通——密钥形态、填充方式、
 * 编码任一处不一致都会失败。这里用真实 fetch 与 WebCrypto 走一遍完整链路，
 * 并把「明文一律被拒」钉成用例：否则某天有人把解密失败改成回落到明文比对，
 * 单测全绿而防护已经消失。
 */

const USERNAME = 'bxzhuo';
const PASSWORD = 'secret123';

const fakeUsers = {
  register: async (username: string) => ({
    id: 1,
    username,
    role: 'admin',
    status: 'active',
    createdAt: '2026-09-30T00:00:00.000Z',
  }),
  authenticate: async (username: string, password: string) =>
    username === USERNAME && password === PASSWORD
      ? { id: 1, username, role: 'admin', status: 'active', createdAt: '2026-09-30T00:00:00.000Z' }
      : null,
  findById: async () => null,
};

const fakeSessions = {
  create: async () => 'token-1',
  remove: async (): Promise<void> => {},
  find: async () => null,
};

const app = express();
app.use(express.json());
// 真实应用中 requestLogger 来自 requestLog 中间件；这里补一个最小替身，避免路由里的日志调用抛错
app.use((_req, res, next) => {
  res.locals.log = { info: () => {}, warn: () => {}, error: () => {} };
  next();
});
app.use(
  '/api/auth',
  createAuthRouter({
    users: fakeUsers as unknown as AppDependencies['users'],
    sessions: fakeSessions as unknown as AppDependencies['sessions'],
    passwordCipher: createPasswordCipher(),
  }),
);

let server: Server;
let baseUrl = '';
let api: ApiClient;

/** 登录请求：password 传什么就发什么，用来对比密文与明文的待遇 */
function login(password: string): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password }),
  });
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  api = createApiClient({ baseURL: baseUrl });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('口令加密传输', () => {
  it('公钥接口下发 RSA 公钥', async () => {
    const response = await fetch(`${baseUrl}/api/auth/public-key`);
    const body = (await response.json()) as { publicKey: { kty: string; n: string } };

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(body.publicKey.kty).toBe('RSA');
    expect(body.publicKey.n).toBeTruthy();
  });

  it('客户端加密后的口令能登录成功，且请求体里不含明文', async () => {
    const password = await encryptPassword(api, PASSWORD);

    expect(password).not.toContain(PASSWORD);
    expect((await login(password)).status).toBe(HTTP_STATUS.OK);
  });

  it('明文口令被拒：加密不是可选项', async () => {
    expect((await login(PASSWORD)).status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it('密文被篡改后登录失败', async () => {
    const tampered = `${(await encryptPassword(api, PASSWORD)).slice(0, -4)}AAAA`;

    expect((await login(tampered)).status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});
