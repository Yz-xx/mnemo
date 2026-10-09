import type { ConcurrencyConfig, GateConfig } from '../configuration/config/index.js';
import type { ConcurrencyGuard } from '../middleware/concurrencyGuard.js';
import type { Logger } from '@repo/logger';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HTTP_STATUS } from '@repo/reusable';
import { retryAfterSeconds } from '../concurrency/gate.js';
import { createConcurrencyGuard } from '../middleware/concurrencyGuard.js';

/** 假响应：闸门只用到 close/finish 事件与几个写出方法，这里给最小实现 */
class FakeResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  readonly headers: Record<string, string> = {};
  writableEnded = false;

  setHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.body = payload;
    return this;
  }
}

/** 静默日志替身：拒绝与超时会记 warn，用例不关心日志内容 */
const logger = { warn: () => undefined } as unknown as Logger;

/** 基准水位：单个用例只关心一种放行/拒绝路径，按需在它之上覆盖 */
const BASE: ConcurrencyConfig = {
  chat: { maxInFlight: 2, softLimit: 1, queueLimit: 1, queueTimeoutMs: 50 },
  upload: { maxInFlight: 1, softLimit: 1, queueLimit: 1, queueTimeoutMs: 50 },
  crud: { maxInFlight: 2, softLimit: 1, queueLimit: 1, queueTimeoutMs: 50 },
  chatMaxDurationMs: 1000,
  sseDrainTimeoutMs: 1000,
  shutdownGraceMs: 1000,
  model: { maxInFlight: 2, softLimit: 1, queueLimit: 1, queueTimeoutMs: 50 },
  summary: { maxInFlight: 1, softLimit: 1, queueLimit: 0, queueTimeoutMs: 50 },
  retrieval: { maxInFlight: 4, softLimit: 2, queueLimit: 1, queueTimeoutMs: 50 },
  retrievalTimeoutMs: 1000,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 30000,
};

/** 建一份 chat 档水位被覆盖的闸门 */
function makeGuard(chat: Partial<GateConfig> = {}): ConcurrencyGuard {
  return createConcurrencyGuard({ ...BASE, chat: { ...BASE.chat, ...chat } }, logger);
}

/** 发一次经闸门的请求：返回响应对象与「是否已被放行」的读取口 */
function request(guard: ConcurrencyGuard): { res: FakeResponse; isAdmitted: () => boolean } {
  const res = new FakeResponse();
  let admitted = false;
  guard.middleware('chat')({} as Request, res as unknown as Response, () => {
    admitted = true;
  });
  return { res, isAdmitted: () => admitted };
}

/** 冲出微任务队列：让闸门内部的 .then 回调有机会执行 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 取 chat 档当前快照 */
function chatSnapshot(guard: ConcurrencyGuard) {
  const snapshot = guard.snapshot().find((item) => item.tier === 'chat');
  if (!snapshot) throw new Error('缺少 chat 档快照');
  return snapshot;
}

describe('createConcurrencyGuard', () => {
  it('软水位之下直接放行，不进入排队', async () => {
    const guard = makeGuard();
    const first = request(guard);

    await flush();
    expect(first.isAdmitted()).toBe(true);
    expect(chatSnapshot(guard)).toMatchObject({ inFlight: 1, queued: 0 });
  });

  it('软水位之上进入有界队列，额度释放后补位放行', async () => {
    const guard = makeGuard();
    const first = request(guard);
    await flush();
    const second = request(guard);
    await flush();

    // 在途数已达软水位：第 2 个请求先排队，而不是一并放行
    expect(second.isAdmitted()).toBe(false);
    expect(chatSnapshot(guard).queued).toBe(1);
    expect(second.res.statusCode).toBe(HTTP_STATUS.OK);

    // 第 1 个收尾归还额度，排队的请求补位
    first.res.emit('finish');
    await flush();
    expect(second.isAdmitted()).toBe(true);
    expect(chatSnapshot(guard)).toMatchObject({ inFlight: 1, queued: 0 });
  });

  it('达到硬水位直接拒绝，并附 Retry-After', async () => {
    const guard = makeGuard({ maxInFlight: 1, softLimit: 1, queueLimit: 1 });
    request(guard);
    await flush();

    const second = request(guard);
    await flush();
    expect(second.isAdmitted()).toBe(false);
    expect(second.res.statusCode).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(second.res.headers['Retry-After']).toBe(String(retryAfterSeconds(BASE.chat)));
  });

  it('队列排满时同样按过载拒绝，不无界堆积等待', async () => {
    const guard = makeGuard({ maxInFlight: 3, softLimit: 1, queueLimit: 1 });
    request(guard);
    await flush();

    const second = request(guard);
    await flush();
    // 队列只允许 1 个：第 3 个请求在入队前即被拒绝
    const third = request(guard);
    await flush();

    expect(second.isAdmitted()).toBe(false);
    expect(third.isAdmitted()).toBe(false);
    expect(third.res.statusCode).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(chatSnapshot(guard)).toMatchObject({ queued: 1, rejected: 1 });
  });

  it('排队等待超时即拒绝，不无限等待', async () => {
    const guard = makeGuard({ queueTimeoutMs: 20 });
    request(guard);
    await flush();

    const queued = request(guard);
    await flush();
    expect(queued.isAdmitted()).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(queued.res.statusCode).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(chatSnapshot(guard)).toMatchObject({ queued: 0, rejected: 1 });
  });

  it('排队期间客户端离开即撤销申请，不占着队列位置空等', async () => {
    const guard = makeGuard({ queueTimeoutMs: 1000 });
    request(guard);
    await flush();

    const queued = request(guard);
    await flush();
    expect(chatSnapshot(guard).queued).toBe(1);

    // 连接关闭时 writableEnded 仍为 false，即「客户端中途离开」而非正常收尾
    queued.res.emit('close');
    await flush();

    expect(queued.isAdmitted()).toBe(false);
    expect(queued.res.statusCode).toBe(HTTP_STATUS.OK);
    expect(chatSnapshot(guard).queued).toBe(0);
  });

  it('退避建议按排队上限折算成秒，至少 1 秒', () => {
    expect(retryAfterSeconds({ ...BASE.chat, queueTimeoutMs: 20000 })).toBe(20);
    expect(retryAfterSeconds({ ...BASE.chat, queueTimeoutMs: 100 })).toBe(1);
  });
});
