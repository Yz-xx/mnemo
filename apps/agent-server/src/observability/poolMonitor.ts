import type { MetricsRegistry } from './metrics.js';
import type { Pool } from 'mysql2/promise';
import { METRIC } from './metricNames.js';

/**
 * 观测连接池（见 docs/adr/0010 决策 17）：入队到取得连接的等待时长是「池是否够用」的
 * 直接信号，池满快速失败的次数则说明水位定得是否合适。
 *
 * 只监听 mysql2 已公开的 `enqueue` / `acquire` 事件，不读池的私有字段。
 * 口径：一次 enqueue 与随后一次 acquire 配对，差值即该次等待；两者数量不匹配时按先进先出近似。
 */

export interface PoolMonitorOptions {
  metrics: MetricsRegistry;
  /** 建连超时（毫秒）：池等待超过它的申请计入「池等待超时数」 */
  connectTimeoutMs: number;
}

export function monitorPool(pool: Pool, options: PoolMonitorOptions): void {
  const { metrics, connectTimeoutMs } = options;
  /** 已入队、尚未取得连接的申请时刻：先进先出配对 */
  const pending: number[] = [];

  pool.on('enqueue', () => {
    pending.push(Date.now());
    metrics.gauge(METRIC.POOL_QUEUED, pending.length);
  });

  pool.on('acquire', () => {
    const startedAt = pending.shift();
    if (startedAt === undefined) return;
    const waitMs = Date.now() - startedAt;
    metrics.observe(METRIC.POOL_WAIT, waitMs);
    // 等待超过建连超时：这次申请虽最终拿到连接，但已越过预期上限，单独计数便于定位池不足
    if (waitMs >= connectTimeoutMs) metrics.increment(METRIC.POOL_WAIT_TIMEOUTS);
    metrics.gauge(METRIC.POOL_QUEUED, pending.length);
  });
}
