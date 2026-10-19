import type { ChatRound } from '../../services/conversation/round.js';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@repo/logger';
import { createMetrics } from '../../infrastructure/observability/index.js';
import { METRIC } from '../../infrastructure/observability/index.js';
import {
  createRoundRegistry,
  RoundConflictError,
} from '../../services/conversation/roundRegistry.js';

const LOGGER = createLogger({ name: 'round-registry-test', level: 'error', stdio: false });

/** 装配一份注册表：超时给足、日志保留给足，只让用例关心的参数可调 */
function makeRegistry(
  overrides: {
    roundMaxDurationMs?: number;
    roundTtlMs?: number;
    detachedMaxRounds?: number;
  } = {},
) {
  const metrics = createMetrics();
  const rounds = createRoundRegistry({
    roundMaxDurationMs: overrides.roundMaxDurationMs ?? 10_000,
    roundTtlMs: overrides.roundTtlMs ?? 60_000,
    detachedMaxRounds: overrides.detachedMaxRounds ?? 2,
    maxLogFrames: 100,
    metrics,
    logger: LOGGER,
  });
  return { rounds, metrics };
}

/** 把一个轮次推入「后台续生成」：先订阅再退订，触发 onIdle 通知注册表 */
async function detach(round: ChatRound): Promise<void> {
  const controller = new AbortController();
  const pending = round.subscribe(0, controller.signal).next();
  controller.abort();
  await pending;
}

describe('createRoundRegistry', () => {
  it('建轮次后计入在途数，取轮次按归属校验', () => {
    const { rounds } = makeRegistry();
    const round = rounds.create(1, 'r-1');

    expect(rounds.activeCount()).toBe(1);
    expect(rounds.get(1, 'r-1')).toBe(round);
    // 他人轮次一律不可见，不泄露「存在但不属于你」
    expect(rounds.get(2, 'r-1')).toBeNull();
  });

  it('同号重复建轮次抛 RoundConflictError，避免同一轮重复生成', () => {
    const { rounds } = makeRegistry();
    rounds.create(1, 'r-1');

    expect(() => rounds.create(1, 'r-1')).toThrow(RoundConflictError);
    expect(rounds.activeCount()).toBe(1);
  });

  it('最后一个订阅者离开时计入后台续生成仪表，轮次仍在途', async () => {
    const { rounds, metrics } = makeRegistry();
    const round = rounds.create(1, 'r-1');

    await detach(round);

    expect(metrics.snapshot().gauges[METRIC.SSE_ROUNDS_DETACHED]).toBe(1);
    expect(metrics.snapshot().gauges[METRIC.SSE_ROUNDS_ACTIVE]).toBe(1);
    expect(round.ended).toBe(false);
  });

  it('后台续生成超过上限时中止最老的一轮', async () => {
    const { rounds } = makeRegistry({ detachedMaxRounds: 2 });
    const first = rounds.create(1, 'r-1');
    const second = rounds.create(1, 'r-2');
    const third = rounds.create(1, 'r-3');

    await detach(first);
    await detach(second);
    expect(first.abortReason).toBeNull();
    // 第三个脱离时超出上限 2：淘汰最老的 first，second 不受影响
    await detach(third);

    expect(first.abortReason).toBe('detached-limit');
    expect(second.abortReason).toBeNull();
  });

  it('已收尾的轮次脱离不占后台续生成额度', async () => {
    const { rounds, metrics } = makeRegistry({ detachedMaxRounds: 1 });
    const round = rounds.create(1, 'r-1');
    round.finish();

    await detach(round);

    expect(metrics.snapshot().gauges[METRIC.SSE_ROUNDS_DETACHED]).toBe(0);
  });

  it('收尾后超过 TTL 即回收轮次，重连窗口随之关闭', async () => {
    const { rounds } = makeRegistry({ roundTtlMs: 5 });
    const round = rounds.create(1, 'r-1');
    round.finish();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(rounds.activeCount()).toBe(0);
    expect(rounds.get(1, 'r-1')).toBeNull();
  });

  it('停机时中止全部在途轮次', () => {
    const { rounds } = makeRegistry();
    const first = rounds.create(1, 'r-1');
    const second = rounds.create(1, 'r-2');

    rounds.abortAll('shutdown');

    expect(first.abortReason).toBe('shutdown');
    expect(second.abortReason).toBe('shutdown');
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});
