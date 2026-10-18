import type { ApiLogEntry } from '../../entities/apiLog.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import { describe, expect, it } from 'vitest';
import { buildFilters } from '../../mappers/apiLog/query.js';
import { ApiLogStore } from '../../mappers/apiLog/store.js';

/** 一条最小日志：批量用例只关心落库时机与批次行数，字段给齐即可 */
function entry(requestId: string): ApiLogEntry {
  return {
    requestId,
    method: 'GET',
    path: '/api/x',
    status: 200,
    durationMs: 1,
    userId: null,
    queryParams: null,
    requestBody: null,
    responseBody: null,
    error: null,
    createdAt: new Date(),
  };
}

/** api_logs 每行的列数：与 store 的 INSERT_COLUMNS 一致，用于把扁平参数折回行数 */
const COLUMNS_PER_ROW = 11;

/** 把扁平参数按列数折回逐行：批量 INSERT 的占位符是逐行逐列摊平的，不是 MySQL 的 `VALUES ?` */
function rowsOf(params: unknown[]): unknown[][] {
  const rows: unknown[][] = [];
  for (let i = 0; i < params.length; i += COLUMNS_PER_ROW) {
    rows.push(params.slice(i, i + COLUMNS_PER_ROW));
  }
  return rows;
}

/** 假连接池：记录每次批量写入的 SQL 与扁平参数；批量刷写只走 query 分支 */
function fakePool() {
  const writes: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as DbPool;
  return { pool, writes };
}

describe('接口日志过滤条件', () => {
  it('无条件时不拼 WHERE，避免出现 "WHERE " 这样的空子句', () => {
    expect(buildFilters({ keyword: '', method: '', statusKind: 'all' })).toEqual({
      where: '',
      params: [],
    });
  });

  it('路径关键词走 strpos，免去对 % 与 _ 的转义', () => {
    expect(buildFilters({ keyword: '/api/chat', method: '', statusKind: 'all' })).toEqual({
      where: 'WHERE strpos(path, $1) > 0',
      params: ['/api/chat'],
    });
  });

  it('三个条件同时成立时，参数顺序与占位符序号一致', () => {
    // 顺序错位不会报错，只会静默查出别的结果，所以逐字断言
    expect(buildFilters({ keyword: '/api/admin', method: 'POST', statusKind: 'client' })).toEqual({
      where: 'WHERE strpos(path, $1) > 0 AND method = $2 AND status >= 400 AND status < 500',
      params: ['/api/admin', 'POST'],
    });
  });

  it('服务端错误档用区间表达，503 之类的具体码不必再登记', () => {
    expect(buildFilters({ keyword: '', method: '', statusKind: 'server' }).where).toBe(
      'WHERE status >= 500',
    );
  });
});

describe('接口日志批量刷写', () => {
  it('未攒够一批时只入缓冲，flush 时一次写完', async () => {
    const { pool, writes } = fakePool();
    // 刷写间隔取大值：本用例只验证攒批行为，不让定时器插进来
    const store = new ApiLogStore(pool, { batchSize: 5, flushIntervalMs: 60_000 });

    store.record(entry('r-1'));
    store.record(entry('r-2'));
    store.record(entry('r-3'));
    // 三条未到阈值，仍在内存缓冲里，不应产生任何写库
    expect(writes).toHaveLength(0);

    // 停机前 await flush 即保证缓冲落尽：定时器被 unref 后不会自己触发（见 docs/adr/0010 决策 13）
    await store.flush();
    expect(writes).toHaveLength(1);
    expect(rowsOf(writes[0].params)).toHaveLength(3);
  });

  it('攒够一批立即落库，不必等定时器', async () => {
    const { pool, writes } = fakePool();
    const store = new ApiLogStore(pool, { batchSize: 2, flushIntervalMs: 60_000 });

    store.record(entry('r-1'));
    store.record(entry('r-2'));

    // record 内触发的是异步刷写：再 await 一次 flush 等到链尾，断言才确定
    await store.flush();
    expect(writes).toHaveLength(1);
    expect(rowsOf(writes[0].params)).toHaveLength(2);
  });

  it('刷写失败只回调 onError，不向上抛，避免拖垮请求或停机', async () => {
    const errors: unknown[] = [];
    const pool = {
      query: async () => {
        throw new Error('写库失败');
      },
    } as unknown as DbPool;
    const store = new ApiLogStore(pool, {
      batchSize: 1,
      flushIntervalMs: 60_000,
      onError: (error) => errors.push(error),
    });

    store.record(entry('r-1'));

    await expect(store.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('落库的 created_at 取调用时刻，而不是刷写时刻', async () => {
    const { pool, writes } = fakePool();
    const store = new ApiLogStore(pool, { batchSize: 5, flushIntervalMs: 60_000 });
    // 造一个明显早于「现在」的调用时刻：若仍用刷写时的 new Date()，断言必然失败
    const calledAt = new Date('2026-10-09T02:00:00.000Z');

    store.record({ ...entry('r-1'), createdAt: calledAt });

    await store.flush();
    // 第 11 列是 created_at（列序见 INSERT_COLUMNS），必须是随条目携带的调用时刻
    expect(rowsOf(writes[0].params)[0][10]).toEqual(calledAt);
  });
});
