import type { AppDependencies } from '../../configuration/dependencies.js';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_STATUS } from '@mnemo/reusable';
import { createAdminAuditRouter } from '../../controllers/admin/audit.js';
import { createAdminConversationsRouter } from '../../controllers/admin/conversations.js';
import { createAdminFilesRouter } from '../../controllers/admin/files.js';
import { createAdminKnowledgeRouter } from '../../controllers/admin/knowledge.js';
import { createAdminLogsRouter } from '../../controllers/admin/logs.js';
import { createAdminUsersRouter } from '../../controllers/admin/users.js';

/**
 * 管理端路由挂载自检。
 * 模块路由内部只写相对路径，前缀由 controllers/index.ts 的 app.use 提供——两边都写了模块名
 * 就会拼出 /api/admin/logs/logs 这类路径，前端一律 404，而类型检查与直接调用处理函数的
 * 单测都发现不了，只有真实请求走一遍 express 匹配才暴露。这里为此留一道回归。
 */

/** 只实现本文件用到的接口，其余成员不参与匹配，故整体断言为对应依赖类型 */
const fakeUsers = {
  list: emptyPage,
  findNamesByIds: async (): Promise<Map<number, string>> => new Map(),
  findById: async (id: number) => ({
    id,
    username: `user-${id}`,
    role: 'user',
    status: 'active',
    createdAt: '2026-09-28T00:00:00.000Z',
  }),
  update: async (id: number, patch: { role?: string; status?: string }) => ({
    id,
    username: `user-${id}`,
    role: patch.role ?? 'user',
    status: patch.status ?? 'active',
    createdAt: '2026-09-28T00:00:00.000Z',
  }),
  // 名额判定只看这个数字：给一个宽裕值，避免路径回归被自锁规则挡住
  countActiveAdmins: async () => 5,
  remove: async () => true,
};

async function emptyPage(): Promise<{ items: never[]; total: number }> {
  return { items: [], total: 0 };
}

const fakeCascade = { removeAllByUser: async (): Promise<void> => {} };
const fakeFiles = { listAll: emptyPage, removeAny: async () => true };
const fakeConversations = { listAll: emptyPage, removeById: async () => true };
const fakeKnowledge = {
  listAll: async (): Promise<never[]> => [],
  remove: async () => true,
  // 内容与编辑替身返回非空结果：挂载正确时回 200，路径拼错时是 404，回归才有区分度
  getContent: async () => ({
    document: {
      id: 'doc-1',
      title: '手册',
      scope: 'global',
      ownerUserId: null,
      chunks: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    content: '正文',
    source: 'raw',
    updatedAt: null,
  }),
  replace: async () => ({
    id: 'doc-1',
    title: '手册',
    scope: 'global',
    ownerUserId: null,
    chunks: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  }),
};

/**
 * 真实服务里 res.locals.admin 与 res.locals.log 分别由 requireAdmin 与 createRequestLog 写入；
 * 本文件只回归路径匹配，用超级令牌身份与空日志补上，否则业务层取不到会抛错。
 */
function fakeAdmin(_req: Request, res: Response, next: NextFunction): void {
  res.locals.admin = { userId: null, superToken: true, role: null };
  res.locals.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
}

const PREFIX = '/api/admin';
const app = express();
app.use(express.json());
app.use(
  `${PREFIX}/audit`,
  createAdminAuditRouter({
    auditLogs: { list: emptyPage } as unknown as AppDependencies['auditLogs'],
    users: fakeUsers as unknown as AppDependencies['users'],
  }),
);
app.use(
  `${PREFIX}/conversations`,
  fakeAdmin,
  createAdminConversationsRouter({
    conversations: fakeConversations as unknown as AppDependencies['conversations'],
    users: fakeUsers as unknown as AppDependencies['users'],
  }),
);
app.use(
  `${PREFIX}/files`,
  fakeAdmin,
  createAdminFilesRouter({
    files: fakeFiles as unknown as AppDependencies['files'],
    users: fakeUsers as unknown as AppDependencies['users'],
  }),
);
app.use(
  `${PREFIX}/knowledge`,
  fakeAdmin,
  createAdminKnowledgeRouter({
    knowledge: fakeKnowledge as unknown as AppDependencies['knowledge'],
    users: fakeUsers as unknown as AppDependencies['users'],
  }),
);
app.use(
  `${PREFIX}/logs`,
  createAdminLogsRouter({
    apiLogs: { list: emptyPage } as unknown as AppDependencies['apiLogs'],
  }),
);
app.use(
  `${PREFIX}/users`,
  fakeAdmin,
  createAdminUsersRouter({
    users: fakeUsers as unknown as AppDependencies['users'],
    sessions: fakeCascade as unknown as AppDependencies['sessions'],
    conversations: fakeCascade as unknown as AppDependencies['conversations'],
    files: fakeCascade as unknown as AppDependencies['files'],
    // 本文件不校验口令，替身只需能被 parseCredentials 调用
    passwordCipher: {
      publicKey: () => ({ kty: 'RSA', n: 'n', e: 'AQAB' }),
      decrypt: () => 'test-password',
    },
  }),
);

let server: Server;
let baseUrl: string;

function postJson(path: string, body: unknown): Promise<globalThis.Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('管理端路由挂载', () => {
  it.each([
    `${PREFIX}/audit`,
    `${PREFIX}/conversations`,
    `${PREFIX}/files`,
    `${PREFIX}/logs`,
    `${PREFIX}/users`,
    `${PREFIX}/knowledge/documents`,
  ])('%s 落到模块路由并回 200', async (path) => {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(HTTP_STATUS.OK);
    await expect(response.json()).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });
});

describe('管理端批量接口', () => {
  it('用户批量变更状态回 200 与实际变更条数', async () => {
    const response = await postJson(`${PREFIX}/users/batch-status`, {
      ids: [1, 2],
      status: 'banned',
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    await expect(response.json()).resolves.toEqual({ updated: 2 });
  });

  it('ids 为空数组时回 400', async () => {
    const response = await postJson(`${PREFIX}/users/batch-status`, { ids: [], status: 'banned' });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it('ids 含非数字项时回 400，不替调用方做类型转换', async () => {
    // Number(true) 得 1、Number(['2']) 得 2，若走强转就会把这些形状当成合法 id
    const response = await postJson(`${PREFIX}/users/batch-status`, {
      ids: [true],
      status: 'banned',
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it.each([
    `${PREFIX}/files/batch-delete`,
    `${PREFIX}/knowledge/documents/batch-delete`,
    `${PREFIX}/conversations/batch-delete`,
  ])('字符串 ID 的 %s 落到模块路由并回 204', async (path) => {
    const response = await postJson(path, { ids: ['a', 'b'] });

    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
  });

  it('用户批量删除接受数字 ID 并回 204', async () => {
    const response = await postJson(`${PREFIX}/users/batch-delete`, { ids: [1, 2] });

    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
  });
});

describe('管理端文档内容与编辑', () => {
  it('内容与编辑接口落到模块路由并回 200（替身返回非空才有区分度）', async () => {
    const documentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const contentResponse = await fetch(
      `${baseUrl}${PREFIX}/knowledge/documents/${documentId}/content`,
    );
    expect(contentResponse.status).toBe(HTTP_STATUS.OK);
    await expect(contentResponse.json()).resolves.toMatchObject({
      content: '正文',
      source: 'raw',
    });

    const putResponse = await fetch(`${baseUrl}${PREFIX}/knowledge/documents/${documentId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新标题', content: '新正文' }),
    });
    expect(putResponse.status).toBe(HTTP_STATUS.OK);
    await expect(putResponse.json()).resolves.toMatchObject({ title: '手册' });
  });
});
