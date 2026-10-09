import { describe, expect, it, vi } from 'vitest';

/** 拦截建池调用：本用例只守护「配置 → 池参数」这条链，不真正连库 */
const { createPool } = vi.hoisted(() => ({ createPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: { createPool } }));

const { createMysqlPool } = await import('../db/pool.js');

describe('createMysqlPool', () => {
  it('把有界队列与建连超时透传给连接池，池满即失败而不是无限排队', () => {
    createMysqlPool({
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: 'secret',
      database: 'agent_data',
      queueLimit: 32,
      connectTimeoutMs: 10000,
    });

    // 缺省 queueLimit 即「排队无上限」，这里必须显式落到池参数上才防得住排队雪崩
    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        waitForConnections: true,
        queueLimit: 32,
        connectTimeout: 10000,
      }),
    );
  });
});
