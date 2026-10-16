import { describe, expect, it, vi } from 'vitest';
import { HTTP_STATUS } from '@repo/reusable';

/**
 * 建池链路：把 pg 的 Pool 换成替身，只守护「配置 → 池参数」与「池满快速失败」两条链，不真正连库。
 * 队列深度上限在 pg 侧没有对应配置（它只约束单次等待时长），只能在应用层补
 * （见 docs/adr/0012 风险 2、docs/adr/0010 P0 生存线）。
 */
const { Pool } = vi.hoisted(() => ({ Pool: vi.fn() }));
vi.mock('pg', () => ({ default: { Pool }, Pool, types: { setTypeParser: vi.fn() } }));

const { createDbPool, createPgPool, DbOverloadedError } = await import('../../db/pool.js');
const { createMetrics } = await import('../../observability/index.js');

/** 过载错误的实例类型：DbOverloadedError 是动态导入的值，取类型须经 InstanceType */
type DbOverloadedFailure = InstanceType<typeof DbOverloadedError>;

/** 建池入参：createPgPool 只读取这几项 */
const CONFIG = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: 'secret',
  database: 'agent_data',
  poolMax: 10,
  queueLimit: 32,
  connectTimeoutMs: 10000,
};

/** 假 pg 池：createDbPool 只用到这几项，等待数可外部改动以驱动闸门分支 */
function fakePool() {
  return {
    waitingCount: 0,
    on: vi.fn(),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })),
    end: vi.fn(async () => undefined),
  };
}

describe('createPgPool', () => {
  it('把池上限与建连超时透传给 pg 池，PG 不可达时尽快失败', () => {
    Pool.mockImplementation(() => fakePool());

    createPgPool(CONFIG);

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({ max: 10, connectionTimeoutMillis: 10000 }),
    );
  });
});

describe('createDbPool 有界排队', () => {
  it('等待数未到上限时照常放行', async () => {
    const pool = fakePool();
    Pool.mockImplementation(() => pool);
    const db = createDbPool(CONFIG, { metrics: createMetrics() });

    await db.query('SELECT 1');

    expect(pool.query).toHaveBeenCalledWith('SELECT 1', undefined);
  });

  it('等待数到 queueLimit 即拒绝，不再往队尾堆', async () => {
    const pool = fakePool();
    pool.waitingCount = CONFIG.queueLimit;
    Pool.mockImplementation(() => pool);
    const db = createDbPool(CONFIG, { metrics: createMetrics() });

    const error = await db.query('SELECT 1').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DbOverloadedError);
    // 过载是可重试的临时态：按 503 + 重试建议交给错误兜底中间件签发响应头
    expect((error as DbOverloadedFailure).status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect((error as DbOverloadedFailure).retryAfterSeconds).toBe(10);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
