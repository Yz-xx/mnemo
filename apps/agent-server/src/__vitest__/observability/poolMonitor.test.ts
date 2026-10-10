import type { Pool } from 'mysql2/promise';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createMetrics, METRIC, monitorPool } from '../../observability/index.js';

/** 假连接池：池监控只依赖 `on` 事件，EventEmitter 足够驱动 enqueue / acquire */
function makePool(): { pool: Pool; emit: (event: string) => void } {
  const emitter = new EventEmitter();
  return { pool: emitter as unknown as Pool, emit: (event) => emitter.emit(event) };
}

describe('monitorPool', () => {
  it('按 enqueue 与 acquire 配对测池等待，排队深度随进出变化', () => {
    const metrics = createMetrics();
    const { pool, emit } = makePool();
    monitorPool(pool, { metrics, connectTimeoutMs: 10000 });

    emit('enqueue');
    expect(metrics.snapshot().gauges[METRIC.POOL_QUEUED]).toBe(1);
    // 尚未取得连接：等待时长还没有样本
    expect(metrics.snapshot().histograms[METRIC.POOL_WAIT]).toBeUndefined();

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
    monitorPool(pool, { metrics, connectTimeoutMs: 0 });

    emit('enqueue');
    emit('acquire');

    expect(metrics.snapshot().counters[METRIC.POOL_WAIT_TIMEOUTS]).toBe(1);
  });

  it('未配对的 acquire（无对应 enqueue）不产生样本，避免污染等待分位数', () => {
    const metrics = createMetrics();
    const { pool, emit } = makePool();
    monitorPool(pool, { metrics, connectTimeoutMs: 10000 });

    emit('acquire');

    expect(metrics.snapshot().histograms[METRIC.POOL_WAIT]).toBeUndefined();
  });
});
