import type { AppConfig } from '../../configuration/config/index.js';
import type { ChatStreamEvent } from '@repo/reusable';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@repo/logger';
import { HTTP_STATUS } from '@repo/reusable';
import { handleRoundResume, handleRoundStop } from '../../controllers/client/chatRoundRoutes.js';
import { createMetrics } from '../../infrastructure/observability/index.js';
import { METRIC } from '../../infrastructure/observability/index.js';
import { createRoundRegistry } from '../../services/conversation/roundRegistry.js';

const USER_ID = 1;
const LOGGER = createLogger({ name: 'chat-round-route-test', level: 'error', stdio: false });

/** 本组用例只读 config.concurrency 的几项：背压等待与日志保留 */
const CONFIG = {
  concurrency: {
    sseDrainTimeoutMs: 30,
    sseRoundTtlMs: 60_000,
    sseDetachedMaxRounds: 4,
    sseReplayMaxEvents: 100,
  },
} as unknown as AppConfig;

/** 假响应：继承 EventEmitter 以接收事件流注册的 close / drain 监听 */
class FakeResponse extends EventEmitter {
  readonly events: ChatStreamEvent[] = [];
  readonly locals = { userId: USER_ID, log: LOGGER };
  statusCode = 200;
  body: unknown;
  writableEnded = false;

  setHeader(): this {
    return this;
  }

  flushHeaders(): void {
    // 无真实 socket，SSE 头部仅需存在该方法
  }

  /** 收集 SSE 帧：每帧形如 `id: <seq>\ndata: {...}\n\n`，此处只取 data 行供断言 */
  write(chunk: string): boolean {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload) this.events.push(JSON.parse(payload) as ChatStreamEvent);
    }
    return true;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.body = payload;
    return this;
  }

  end(): void {
    this.writableEnded = true;
  }
}

/** 假依赖：只装配续传与停止用到的注册表、指标与配置 */
function fakeDeps() {
  const metrics = createMetrics();
  const rounds = createRoundRegistry({
    roundMaxDurationMs: 10_000,
    roundTtlMs: 60_000,
    detachedMaxRounds: 4,
    maxLogFrames: 100,
    metrics,
    logger: LOGGER,
  });
  return { rounds, config: CONFIG, metrics };
}

function fakeRequest(params: { roundId: string }, query: Record<string, string> = {}): Request {
  return { params, query } as unknown as Request;
}

describe('handleRoundResume', () => {
  it('轮次不存在或已过期时按 404 返回，并计入重连失败', async () => {
    const deps = fakeDeps();
    const res = new FakeResponse();

    await handleRoundResume(
      deps,
      fakeRequest({ roundId: 'r-missing' }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    expect(res.body).toEqual({ message: '本轮对话不存在或已结束' });
    expect(deps.metrics.snapshot().counters[METRIC.SSE_RESUME_FAILED]).toBe(1);
  });

  it('轮次归属他人时同样按 404 处理，不泄露存在性', async () => {
    const deps = fakeDeps();
    deps.rounds.create(2, 'r-他人');
    const res = new FakeResponse();

    await handleRoundResume(deps, fakeRequest({ roundId: 'r-他人' }), res as unknown as Response);

    expect(res.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it('从断点之后重放日志，并计入重连与重放帧数', async () => {
    const deps = fakeDeps();
    const round = deps.rounds.create(USER_ID, 'r-1');
    round.publish({ type: 'token', content: 'a' });
    round.publish({ type: 'token', content: 'b' });
    round.publish({ type: 'token', content: 'c' });
    round.finish();
    const res = new FakeResponse();

    await handleRoundResume(
      deps,
      fakeRequest({ roundId: 'r-1' }, { lastEventId: '1' }),
      res as unknown as Response,
    );

    // 只补发 seq 1 之后的 b、c，已消费的 a 不再重发
    expect(res.events).toEqual([
      { type: 'token', content: 'b' },
      { type: 'token', content: 'c' },
    ]);
    expect(res.writableEnded).toBe(true);
    expect(deps.metrics.snapshot().counters[METRIC.SSE_RESUMES]).toBe(1);
    expect(deps.metrics.snapshot().counters[METRIC.SSE_REPLAYED_FRAMES]).toBe(2);
  });

  it('断点缺失或非法时从头重放，且不计续传帧数', async () => {
    const deps = fakeDeps();
    const round = deps.rounds.create(USER_ID, 'r-1');
    round.publish({ type: 'token', content: 'a' });
    round.publish({ type: 'token', content: 'b' });
    round.finish();

    const first = new FakeResponse();
    await handleRoundResume(deps, fakeRequest({ roundId: 'r-1' }), first as unknown as Response);
    expect(first.events).toHaveLength(2);

    const second = new FakeResponse();
    await handleRoundResume(
      deps,
      fakeRequest({ roundId: 'r-1' }, { lastEventId: '-5' }),
      second as unknown as Response,
    );
    expect(second.events).toHaveLength(2);
    // 从头重放是首次订阅而非补发，不贡献续传帧数
    expect(deps.metrics.snapshot().counters[METRIC.SSE_REPLAYED_FRAMES]).toBeUndefined();
  });

  it('续传期间新产出的事件实时接上，不丢帧', async () => {
    const deps = fakeDeps();
    const round = deps.rounds.create(USER_ID, 'r-1');
    round.publish({ type: 'token', content: 'a' });
    const res = new FakeResponse();

    const pending = handleRoundResume(
      deps,
      fakeRequest({ roundId: 'r-1' }),
      res as unknown as Response,
    );
    // 订阅已同步挂上：此刻新推的帧应实时送达，而不是落在重放窗口之外
    round.publish({ type: 'token', content: 'b' });
    round.finish();
    await pending;

    expect(res.events).toEqual([
      { type: 'token', content: 'a' },
      { type: 'token', content: 'b' },
    ]);
  });
});

describe('handleRoundStop', () => {
  it('按 user 原因中止本轮并返回 204', () => {
    const deps = fakeDeps();
    const round = deps.rounds.create(USER_ID, 'r-1');
    const res = new FakeResponse();

    handleRoundStop(deps, fakeRequest({ roundId: 'r-1' }), res as unknown as Response);

    // 中止原因记为 user：收尾时轮次任务据此回推一条 error 帧
    expect(round.abortReason).toBe('user');
    expect(round.signal.aborted).toBe(true);
    expect(res.statusCode).toBe(HTTP_STATUS.NO_CONTENT);
  });

  it('轮次不存在时返回 404', () => {
    const deps = fakeDeps();
    const res = new FakeResponse();

    handleRoundStop(deps, fakeRequest({ roundId: 'r-missing' }), res as unknown as Response);

    expect(res.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    expect(res.body).toEqual({ message: '本轮对话不存在或已结束' });
  });
});
