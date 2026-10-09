import { describe, expect, it } from 'vitest';
import { createMetrics } from '../observability/index.js';

describe('createMetrics', () => {
  it('累加计数与覆盖式计量各自独立存放', () => {
    const metrics = createMetrics();
    metrics.increment('gate.rejected');
    metrics.increment('gate.rejected', 2);
    metrics.gauge('pool.queued', 3);
    metrics.gauge('pool.queued', 1);

    const snapshot = metrics.snapshot();
    expect(snapshot.counters['gate.rejected']).toBe(3);
    // 计量器是覆盖语义：后一次写入覆盖前一次，而不是累加
    expect(snapshot.gauges['pool.queued']).toBe(1);
  });

  it('直方图给出分位数与极值，样本不足时 P95 退化为最大值', () => {
    const metrics = createMetrics();
    [10, 20, 30, 40].forEach((value) => metrics.observe('llm.roundMs', value));

    expect(metrics.snapshot().histograms['llm.roundMs']).toMatchObject({
      count: 4,
      avgMs: 25,
      p50Ms: 20,
      p95Ms: 40,
      maxMs: 40,
    });
  });

  it('样本超过窗口上限时丢弃最老样本，长跑下内存仍有上界', () => {
    const metrics = createMetrics({ histogramSize: 3 });
    [1, 2, 3, 4, 5].forEach((value) => metrics.observe('db.appendMs', value));

    const summary = metrics.snapshot().histograms['db.appendMs'];
    // 只保留最近 3 个样本，最大值仍反映最新观测
    expect(summary.count).toBe(3);
    expect(summary.maxMs).toBe(5);
  });
});
