import type { PostgresConfig } from '../../configuration/config/index.js';
import type { MetricsRegistry } from '../observability/index.js';
import type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { Pool as PgPool, types } from 'pg';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { monitorPool } from '../observability/poolMonitor.js';

/**
 * 全局类型解析：pg 默认把 int8（BIGINT / COUNT(*)）按字符串返回。
 * 不收敛则分页总数、统计值、会话 ID 会在运算处静默变成字符串（见 docs/adr/0012 风险 1）。
 * 解析器注册是进程级的，关系库与向量库两张池共用这一次注册，故落在建池模块顶层。
 */
types.setTypeParser(20, (value) => Number(value));

/**
 * 应用侧连接池：pg 的池 + 应用侧有界排队（见 docs/adr/0012 风险 2）。
 * 只暴露三个成员，让路由层与 store 层不依赖 pg 池的实现细节。
 */
export interface DbPool {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
  /** 取一条连接用于事务：调用方用毕必须 release */
  connect(): Promise<PoolClient>;
  /** 关闭池：停机时由组合根调用 */
  end(): Promise<void>;
}

/**
 * 池满快速失败：ADR 0010 的 P0 生存线依赖 `queueLimit`，而 pg 的池会把超出的申请无界排队
 * （`connectionTimeoutMillis` 只约束单次等待时长，不约束队列深度）。
 * 过载是「可重试的临时态」，故带上 503 与 Retry-After 交给错误兜底中间件签发，
 * 与并发闸门在同一处出口、同一套文案（见 docs/adr/0010）。
 */
export class DbOverloadedError extends Error {
  readonly status = HTTP_STATUS.SERVICE_UNAVAILABLE;

  constructor(readonly retryAfterSeconds: number) {
    super(ERROR_MESSAGE.OVERLOADED);
    this.name = 'DbOverloadedError';
  }
}

/** 建池：关系库与向量库共用同一份 PostgreSQL 连接参数（见 docs/adr/0012 阶段 2 决策 1） */
export function createPgPool(config: PostgresConfig): Pool {
  const options: PoolConfig = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: config.poolMax,
    // 等不到连接的超时：PG 不可达时尽快失败，不让请求一直挂在握手上
    connectionTimeoutMillis: config.connectTimeoutMs,
  };
  return new PgPool(options);
}

/**
 * 建应用侧连接池：在 pg 池之上补回「排队深度有界」这一条。
 * 每次取连接前先看池的等待数，已到 `queueLimit` 就当场拒绝，不再往队尾堆——
 * 于是过载时请求以 503 快速失败，而不是在池里排到连接超时才觉察。
 */
export function createDbPool(
  config: PostgresConfig,
  options: { metrics: MetricsRegistry },
): DbPool {
  const pool = createPgPool(config);
  const monitor = monitorPool(pool, {
    metrics: options.metrics,
    connectTimeoutMs: config.connectTimeoutMs,
  });
  // 退避建议按建连超时折算：队列已满时，等到下一次重试至少要过这么久
  const retryAfter = Math.max(1, Math.ceil(config.connectTimeoutMs / 1000));

  /** 入池前的快速失败：队列已满即拒绝，避免排队等待无界增长 */
  const guardQueue = (): void => {
    if (pool.waitingCount >= config.queueLimit) throw new DbOverloadedError(retryAfter);
  };

  return {
    async query(sql, params) {
      guardQueue();
      monitor.attempted();
      return pool.query(sql, params);
    },
    async connect() {
      guardQueue();
      monitor.attempted();
      return pool.connect();
    },
    end: () => pool.end(),
  };
}
