import type { ApiLogEntry } from '../logging/store.js';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { ApiLogStore, buildFilters } from '../logging/store.js';

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
  };
}

/** 假连接池：记录每次批量 INSERT 的行数；批量刷写走 query（多行占位符），故只实现 query 分支 */
function fakePool() {
  const batches: unknown[][] = [];
  const pool = {
    query: async (_sql: string, params: unknown[][]) => {
      batches.push(params[0]);
      return [{ affectedRows: params[0].length }];
    },
  } as unknown as Pool;
  return { pool, batches };
}

describe('接口日志过滤条件', () => {
  it('无条件时不拼 WHERE，避免出现 "WHERE " 这样的空子句', () => {
    expect(buildFilters({ keyword: '', method: '', statusKind: 'all' })).toEqual({
      where: '',
      params: [],
    });
  });

  it('路径关键词走 LOCATE，免去对 % 与 _ 的转义', () => {
    expect(buildFilters({ keyword: '/api/chat', method: '', statusKind: 'all' })).toEqual({
      where: 'WHERE LOCATE(?, path) > 0',
      params: ['/api/chat'],
    });
  });

  it('三个条件同时成立时，参数顺序与占位符出现顺序一致', () => {
    // 顺序错位不会报错，只会静默查出别的结果，所以逐字断言
    expect(buildFilters({ keyword: '/api/admin', method: 'POST', statusKind: 'client' })).toEqual({
      where: 'WHERE LOCATE(?, path) > 0 AND method = ? AND status >= 400 AND status < 500',
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
    const { pool, batches } = fakePool();
    // 刷写间隔取大值：本用例只验证攒批行为，不让定时器插进来
    const store = new ApiLogStore(pool, { batchSize: 5, flushIntervalMs: 60_000 });

    store.record(entry('r-1'));
    store.record(entry('r-2'));
    store.record(entry('r-3'));
    // 三条未到阈值，仍在内存缓冲里，不应产生任何写库
    expect(batches).toHaveLength(0);

    // 停机前 await flush 即保证缓冲落尽：定时器被 unref 后不会自己触发（见 docs/adr/0010 决策 13）
    await store.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('攒够一批立即落库，不必等定时器', async () => {
    const { pool, batches } = fakePool();
    const store = new ApiLogStore(pool, { batchSize: 2, flushIntervalMs: 60_000 });

    store.record(entry('r-1'));
    store.record(entry('r-2'));

    // record 内触发的是异步刷写：再 await 一次 flush 等到链尾，断言才确定
    await store.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('刷写失败只回调 onError，不向上抛，避免拖垮请求或停机', async () => {
    const errors: unknown[] = [];
    const pool = {
      query: async () => {
        throw new Error('写库失败');
      },
    } as unknown as Pool;
    const store = new ApiLogStore(pool, {
      batchSize: 1,
      flushIntervalMs: 60_000,
      onError: (error) => errors.push(error),
    });

    store.record(entry('r-1'));

    await expect(store.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
