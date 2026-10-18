import type { DbPool } from '../../infrastructure/db/pool.js';
import { describe, expect, it } from 'vitest';
import { UserStore } from '../../mappers/user/store.js';

/**
 * 超管自举的回归：只在库里没有任何后台侧账号时创建，已有则原样跳过。
 * 「新库要能进后台」与「不覆盖既有账号」这两条靠同一个判据平衡，写错任一边都很难在部署后发现。
 */

/** 假连接池：按调用顺序吐出预置结果，并记录每次 SQL 的参数 */
function fakePool(responses: unknown[]): { pool: DbPool; params: unknown[][] } {
  const params: unknown[][] = [];
  let index = 0;
  const pool = {
    query: async (_sql: string, values?: unknown[]) => {
      params.push(values ?? []);
      return responses[index++];
    },
  };
  return { pool: pool as unknown as DbPool, params };
}

/** COUNT 查询的返回：总数放在第一行 */
const countRows = (total: number): unknown => ({ rows: [{ total }], rowCount: 1 });

/** INSERT 落库成功：PG 走 ON CONFLICT DO NOTHING，rowCount 说明是否真的插入了 */
const CREATED_INSERT = { rows: [], rowCount: 1 };

/** INSERT 被唯一约束挡下：rowCount 为 0 */
const IGNORED_INSERT = { rows: [], rowCount: 0 };

const PASSWORD = 'secret123';

describe('超管自举', () => {
  it('库里没有任何后台账号时创建超管，且角色写为 super_admin', async () => {
    const { pool, params } = fakePool([countRows(0), CREATED_INSERT]);
    const store = new UserStore(pool);

    await expect(store.ensureSuperAdmin('root', PASSWORD)).resolves.toBe('created');
    expect(params[1]).toEqual([
      'root',
      expect.stringMatching(/^scrypt\$/),
      'super_admin',
      'active',
      expect.any(Date),
    ]);
  });

  it('库里已有后台账号时原样跳过：不覆盖，也不新增', async () => {
    const { pool, params } = fakePool([countRows(1)]);
    const store = new UserStore(pool);

    await expect(store.ensureSuperAdmin('root', PASSWORD)).resolves.toBe('skipped');
    expect(params).toHaveLength(1);
  });

  it('用户名被客户端账号占用时报出来，避免超管没建出来却无人知晓', async () => {
    const { pool } = fakePool([countRows(0), IGNORED_INSERT]);
    const store = new UserStore(pool);

    await expect(store.ensureSuperAdmin('root', PASSWORD)).resolves.toBe('username-taken');
  });
});
