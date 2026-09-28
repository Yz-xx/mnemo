import { describe, expect, it } from 'vitest';
import { buildFilters } from '../logging/store.js';

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
