import type { Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { UserStore } from '../auth/userStore/index.js';

/**
 * 超管自举的回归：只在库里没有任何后台侧账号时创建，已有则原样跳过。
 * 「新库要能进后台」与「不覆盖既有账号」这两条靠同一个判据平衡，写错任一边都很难在部署后发现。
 */

/** 假连接池：按调用顺序吐出预置结果，并记录每次 SQL 的参数 */
function fakePool(responses: unknown[]): { pool: Pool; params: unknown[][] } {
  const params: unknown[][] = [];
  let index = 0;
  const pool = {
    execute: async (_sql: string, values?: unknown[]) => {
      params.push(values ?? []);
      return responses[index++];
    },
  };
  return { pool: pool as unknown as Pool, params };
}

/** COUNT 查询的返回：总数放在第一行 */
function countRows(total: number): unknown[] {
  return [[{ total }], []];
}

/** INSERT 被唯一索引挡下：affectedRows 为 0 */
const IGNORED_INSERT = [{ affectedRows: 0 }, []];

const PASSWORD = 'secret123';

describe('超管自举', () => {
  it('库里没有任何后台账号时创建超管，且角色写为 super_admin', async () => {
    const { pool, params } = fakePool([countRows(0), [{ affectedRows: 1 }, []]]);
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
