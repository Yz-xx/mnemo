import { describe, expect, it } from 'vitest';
import { HTTP_STATUS, toHttpStatusCode } from '../http.js';

describe('HTTP 状态码契约', () => {
  it('取值与 backend-design 第 3 章的约定逐项一致', () => {
    expect(HTTP_STATUS).toEqual({
      OK: 200,
      CREATED: 201,
      NO_CONTENT: 204,
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      NOT_FOUND: 404,
      INTERNAL_SERVER_ERROR: 500,
    });
  });

  it('取值互不重复，避免新增时复制粘贴漏改数字', () => {
    const codes = Object.values(HTTP_STATUS);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('收窄：契约内的状态码原样返回', () => {
    expect(toHttpStatusCode(200)).toBe(200);
    expect(toHttpStatusCode(401)).toBe(401);
  });

  it('收窄：契约外的状态码回落为 500，不把网关/代理的码漏给调用方', () => {
    expect(toHttpStatusCode(403)).toBe(500);
    expect(toHttpStatusCode(0)).toBe(500);
  });
});
