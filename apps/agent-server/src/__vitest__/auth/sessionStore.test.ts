import type { Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../../auth/sessionStore.js';

/** 会话行：与 user_sessions 的读取列一致 */
interface FakeSession {
  userId: number;
  expiresAt: Date;
}

/**
 * 假连接池：只实现 SessionStore 用到的 SELECT / DELETE 分支，并统计回源次数，
 * 用来验证「命中缓存就不再查库」与「登出后缓存立即失效」。
 */
function fakePool(sessions: Map<string, FakeSession>) {
  const state = { selects: 0 };
  const pool = {
    execute: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        state.selects += 1;
        const row = sessions.get(params[0] as string);
        return [row ? [{ user_id: row.userId, expires_at: row.expiresAt }] : []];
      }
      if (sql.startsWith('DELETE FROM user_sessions WHERE token')) {
        sessions.delete(params[0] as string);
      }
      return [{ affectedRows: 1 }];
    },
  } as unknown as Pool;
  return { pool, selects: () => state.selects };
}

const future = (): Date => new Date(Date.now() + 60_000);

describe('SessionStore 鉴权结果缓存', () => {
  it('同一令牌重复校验只在首次回源数据库', async () => {
    const sessions = new Map([['tok', { userId: 7, expiresAt: future() }]]);
    const { pool, selects } = fakePool(sessions);
    const store = new SessionStore(pool, 5000);

    await expect(store.resolve('tok')).resolves.toBe(7);
    await expect(store.resolve('tok')).resolves.toBe(7);

    // 鉴权每请求一次，第二次命中缓存即省下这次查询（见 docs/adr/0010 决策 13）
    expect(selects()).toBe(1);
  });

  it('登出后缓存立即失效，再次校验回源并判定失效', async () => {
    const sessions = new Map([['tok', { userId: 7, expiresAt: future() }]]);
    const { pool, selects } = fakePool(sessions);
    const store = new SessionStore(pool, 5000);

    await expect(store.resolve('tok')).resolves.toBe(7);
    await store.remove('tok');

    // 会话已在库里删除，缓存必须同步失效：否则被登出的令牌在 TTL 内还能继续进
    await expect(store.resolve('tok')).resolves.toBeNull();
    expect(selects()).toBe(2);
  });

  it('已过期令牌不入缓存，每次校验都回源', async () => {
    const sessions = new Map([['tok', { userId: 7, expiresAt: new Date(Date.now() - 1000) }]]);
    const { pool, selects } = fakePool(sessions);
    const store = new SessionStore(pool, 5000);

    await expect(store.resolve('tok')).resolves.toBeNull();
    await expect(store.resolve('tok')).resolves.toBeNull();
    expect(selects()).toBe(2);
  });
});
