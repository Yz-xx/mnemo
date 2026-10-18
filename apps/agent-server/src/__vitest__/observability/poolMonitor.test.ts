import type { Pool } from 'pg';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createMetrics, METRIC, monitorPool } from '../../infrastructure/observability/index.js';

/**
 * 假连接池：pg 只 emit `acquire`，没有与 `enqueue` 配对的事件，
 * 故申请时刻改由调用方（db/pool.ts）在申请前补给；队列深度直接读池公开的 `waitingCount`。
 */
function makePool() {
  const state = { waitingCount: 0 };
  const emitter = new EventEmitter();
  // waitingCount 是 pg 池的公开只读属性，这里用取值器挂在事件器上，既像真池又能被用例驱动
  Object.defineProperty(emitter, 'waitingCount', { get: () => state.waitingCount });
  return {
    pool: emitter as unknown as Pool,
    emit: (event: string) => emitter.emit(event),
    setWaiting: (value: number) => {
      state.waitingCount = value;
    },
  };
}

describe('monitorPool', () => {
  it('按 attempted 与 acquire 配对测池等待，排队深度取自池的 waitingCount', () => {
    const metrics = createMetrics();
    const { pool, emit, setWaiting } = makePool();
    const monitor = monitorPool(pool, { metrics, connectTimeoutMs: 10000 });

    setWaiting(1);
    monitor.attempted();
    expect(metrics.snapshot().gauges[METRIC.POOL_QUEUED]).toBe(1);
    // 尚未取得连接：等待时长还没有样本
    expect(metrics.snapshot().histograms[METRIC.POOL_WAIT]).toBeUndefined();

    setWaiting(0);
    emit('acquire');
    const snapshot = metrics.snapshot();
    expect(snapshot.gauges[METRIC.POOL_QUEUED]).toBe(0);
    expect(snapshot.histograms[METRIC.POOL_WAIT].count).toBe(1);
    // 等待时间极短，不可能越过建连超时
    expect(snapshot.counters[METRIC.POOL_WAIT_TIMEOUTS]).toBeUndefined();
  });

  it('等待超过建连超时即计入池等待超时数，提示水位可能偏低', () => {
    const metrics = createMetrics();
    const { pool, emit } = makePool();
    // 建连超时设为 0：任何一次等待都判为超时，无需真的等待
    const monitor = monitorPool(pool, { metrics, connectTimeoutMs: 0 });

    monitor.attempted();
    emit('acquire');

    expect(metrics.snapshot().counters[METRIC.POOL_WAIT_TIMEOUTS]).toBe(1);
  });

  it('未配对的 acquire（无对应 attempted）不产生样本，避免污染等待分位数', () => {
    const metrics = createMetrics();
    const { pool, emit } = makePool();
    monitorPool(pool, { metrics, connectTimeoutMs: 10000 });

    emit('acquire');

    expect(metrics.snapshot().histograms[METRIC.POOL_WAIT]).toBeUndefined();
  });
});
