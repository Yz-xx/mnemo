import type { MetricsRegistry } from './metrics.js';
import type { Pool } from 'pg';
import { METRIC } from './metricNames.js';

/**
 * 观测连接池（见 docs/adr/0010 决策 17）：入队到取得连接的等待时长是「池是否够用」的
 * 直接信号，池满快速失败的次数则说明水位定得是否合适。
 *
 * pg 只 emit `acquire`，没有与「入队」配对的事件，故由调用方（db/pool.ts）在每次申请前
 * 调用 `attempted()` 记下申请时刻，再与随后的 `acquire` 配对——按先进先出近似，两者数量
 * 不匹配时靠后一批错位。队列深度不再自己数，直接读 pg 池公开的 `waitingCount`，口径与池内一致。
 */

export interface PoolMonitorOptions {
  metrics: MetricsRegistry;
  /** 建连超时（毫秒）：池等待超过它的申请计入「池等待超时数」 */
  connectTimeoutMs: number;
}

/** 池观测器：申请时刻须由调用方补给，故不能只靠事件驱动 */
export interface PoolMonitor {
  /** 每次向池申请连接之前调用：与随后的 acquire 事件配对，得到该次等待时长 */
  attempted(): void;
}

export function monitorPool(pool: Pool, options: PoolMonitorOptions): PoolMonitor {
  const { metrics, connectTimeoutMs } = options;
  /** 已申请、尚未取得连接的时刻：先进先出配对 */
  const pending: number[] = [];

  const reportQueueDepth = (): void => {
    metrics.gauge(METRIC.POOL_QUEUED, pool.waitingCount);
  };

  pool.on('acquire', () => {
    reportQueueDepth();
    const startedAt = pending.shift();
    if (startedAt === undefined) return;
    const waitMs = Date.now() - startedAt;
    metrics.observe(METRIC.POOL_WAIT, waitMs);
    // 等待超过建连超时：这次申请虽最终拿到连接，但已越过预期上限，单独计数便于定位池不足
    if (waitMs >= connectTimeoutMs) metrics.increment(METRIC.POOL_WAIT_TIMEOUTS);
  });

  return {
    attempted: () => {
      pending.push(Date.now());
      reportQueueDepth();
    },
  };
}
