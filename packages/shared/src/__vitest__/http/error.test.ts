import type { HttpResponse } from '../../http/index.js';
import { describe, expect, it } from 'vitest';
import { createHttpClient, HttpError, isHttpError } from '../../http/index.js';
import { createFetchStub, jsonResponse } from './helpers.js';

describe('错误归一化', () => {
  it('非 2xx 抛 HTTP_ERROR，带原始状态码与服务端 message', async () => {
    const stub = createFetchStub(() => jsonResponse({ message: '参数非法' }, 400));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await expect(client.get('/users')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 400,
      message: '参数非法',
    });
  });

  it('错误体不是 JSON 时 message 退化为状态码提示', async () => {
    const stub = createFetchStub(
      () => new Response('服务器炸了', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await expect(client.get('/users')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 500,
      message: '请求失败（HTTP 500）',
    });
  });

  it('网络失败归为 NETWORK_ERROR 并保留原始错误', async () => {
    const cause = new TypeError('fetch failed');
    const stub = createFetchStub(() => {
      throw cause;
    });
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await expect(client.get('/users')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'fetch failed',
      cause,
    });
  });

  it('错误拦截器返回 HttpResponse 即视为恢复，该响应成为请求结果', async () => {
    const stub = createFetchStub(() => jsonResponse({ message: '失败' }, 500));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });
    client.interceptors.error.use((error): HttpResponse => {
      const raw = error.response?.raw ?? new Response(null);
      return { data: { fallback: true }, status: 200, headers: raw.headers, raw };
    });

    await expect(client.get('/users')).resolves.toEqual({ fallback: true });
  });

  it('错误拦截器返回 HttpError 时改抛该错误', async () => {
    const stub = createFetchStub(() => jsonResponse({ message: '失败' }, 500));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });
    client.interceptors.error.use(
      () => new HttpError({ code: 'ABORTED', message: '替换后的错误' }),
    );

    await expect(client.get('/users')).rejects.toMatchObject({
      code: 'ABORTED',
      message: '替换后的错误',
    });
  });

  it('isHttpError 能判别 HttpError 与普通异常', () => {
    expect(isHttpError(new HttpError({ code: 'TIMEOUT', message: '超时' }))).toBe(true);
    expect(isHttpError(new Error('普通异常'))).toBe(false);
  });
});
