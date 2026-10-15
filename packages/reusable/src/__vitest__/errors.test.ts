import { describe, expect, it } from 'vitest';
import { HttpError } from '@repo/shared';
import { isUnauthorized } from '../errors.js';

/** 造一个带状态码的传输成功但状态非 2xx 的错误 */
function httpError(status: number): HttpError {
  return new HttpError({ message: `请求失败（HTTP ${status}）`, code: 'HTTP_ERROR', status });
}

describe('isUnauthorized', () => {
  it('契约内的 401 视为登录失效', () => {
    expect(isUnauthorized(httpError(401))).toBe(true);
  });

  it('契约外的 403 经收敛归到 500，不误判为登录失效', () => {
    expect(isUnauthorized(httpError(403))).toBe(false);
  });

  it('传输类错误（status 缺省为 0）不视为登录失效', () => {
    const error = new HttpError({ message: '网络错误', code: 'NETWORK_ERROR' });
    expect(isUnauthorized(error)).toBe(false);
  });

  it('非 HttpError 一律不视为登录失效', () => {
    expect(isUnauthorized(new Error('401'))).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
    expect(isUnauthorized('401')).toBe(false);
  });
});
