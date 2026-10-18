import type { AuditLogEntry } from '../../entities/auditLog.js';
import type { AdminActor } from '../../infrastructure/auth/actor.js';
import type { AuditLogStore } from '../../mappers/auditLog.js';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HTTP_STATUS } from '@repo/reusable';
import { createAdminAudit } from '../../middleware/adminAudit.js';

/**
 * 审计中间件只用到 locals / statusCode 与 res.on('finish')，
 * 因此用一个最小的假响应替身隔离 Express，直接观察投递出来的审计条目。
 */
class FakeResponse extends EventEmitter {
  readonly locals: Record<string, unknown> = {};
  statusCode: number = HTTP_STATUS.OK;
}

/** 假请求：只支持中间件读取的三个字段 */
function fakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    originalUrl: '/api/admin/users/12',
    body: { role: 'admin' },
    ...overrides,
  } as unknown as Request;
}

interface Scenario {
  method?: string;
  originalUrl?: string;
  body?: unknown;
  status?: number;
  actor?: AdminActor;
}

/** 走一遍中间件并触发 finish，返回期间投递的审计条目 */
function invoke(scenario: Scenario = {}): AuditLogEntry[] {
  const entries: AuditLogEntry[] = [];
  const auditLogs = {
    record: async (entry: AuditLogEntry) => {
      entries.push(entry);
    },
  } as unknown as AuditLogStore;

  const handler = createAdminAudit(auditLogs);
  const res = new FakeResponse();
  res.statusCode = scenario.status ?? HTTP_STATUS.OK;
  res.locals.admin = scenario.actor ?? { userId: 7, superToken: false };
  res.locals.log = { warn: () => undefined };

  let nextCalled = false;
  handler(
    fakeRequest({
      method: scenario.method ?? 'POST',
      originalUrl: scenario.originalUrl ?? '/api/admin/users/12',
      body: scenario.body ?? { role: 'admin' },
    }),
    res as unknown as Response,
    () => {
      nextCalled = true;
    },
  );

  expect(nextCalled).toBe(true);
  res.emit('finish');
  return entries;
}

describe('管理端操作审计', () => {
  it('读操作不留档，避免审计页被浏览记录淹没', () => {
    expect(invoke({ method: 'GET' })).toHaveLength(0);
  });

  it('写操作在响应结束后登记操作人、方法、路径与结果', () => {
    const entries = invoke({ method: 'PATCH', status: HTTP_STATUS.OK });

    expect(entries).toEqual([
      {
        actorId: 7,
        method: 'PATCH',
        path: '/api/admin/users/12',
        status: HTTP_STATUS.OK,
        detail: expect.stringContaining('admin'),
      },
    ]);
  });

  it('路径不带查询串：筛选条件不属于「改了什么」', () => {
    const entries = invoke({ originalUrl: '/api/admin/users/12?force=true' });

    expect(entries[0]?.path).toBe('/api/admin/users/12');
  });

  it('失败的写入尝试同样留档，便于回溯越权与误操作', () => {
    const entries = invoke({ status: HTTP_STATUS.NOT_FOUND });

    expect(entries[0]?.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it('请求体先脱敏再入库，密码不会以明文落进审计', () => {
    const entries = invoke({ body: { username: 'guest', password: 'plain-secret' } });

    expect(entries[0]?.detail).not.toContain('plain-secret');
  });

  it('无请求体时 detail 为空，不留一个空对象占位', () => {
    const entries = invoke({ body: {} });

    expect(entries[0]?.detail).toBeNull();
  });

  it('运维超级令牌入口不对应具体账号，操作人记为空', () => {
    const entries = invoke({ actor: { userId: null, superToken: true, role: null } });

    expect(entries[0]?.actorId).toBeNull();
  });
});
