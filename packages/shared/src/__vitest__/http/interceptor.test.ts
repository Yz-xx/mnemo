import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../../http/index.js';
import { createFetchStub, jsonResponse, pendingFetch } from './helpers.js';

describe('拦截器链', () => {
  it('请求拦截器逆序执行，响应拦截器正序执行', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });
    const order: string[] = [];

    client.interceptors.request.use((config) => {
      order.push('req1');
      return config;
    });
    client.interceptors.request.use((config) => {
      order.push('req2');
      return config;
    });
    client.interceptors.response.use((response) => {
      order.push('res1');
      return response;
    });
    client.interceptors.response.use((response) => {
      order.push('res2');
      return response;
    });

    await client.get('/users');

    expect(order).toEqual(['req2', 'req1', 'res1', 'res2']);
  });

  it('eject 后处理器不再执行', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });
    const order: string[] = [];

    const id = client.interceptors.request.use((config) => {
      order.push('req');
      return config;
    });
    client.interceptors.request.eject(id);
    await client.get('/users');

    expect(order).toEqual([]);
  });

  it('请求拦截器可改写已合并的配置', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({
      baseURL: 'https://api.test',
      headers: { 'X-Trace': 'default' },
      fetch: stub.fetch,
    });
    client.interceptors.request.use((config) => ({
      ...config,
      headers: { ...config.headers, 'X-Trace': 'rewritten' },
    }));

    await client.get('/users');

    expect(stub.calls[0].init.headers).toMatchObject({ 'X-Trace': 'rewritten' });
  });

  it('响应拦截器可改写结果', async () => {
    const stub = createFetchStub(() => jsonResponse({ id: 1 }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });
    client.interceptors.response.use((response) => ({ ...response, data: { wrapped: true } }));

    await expect(client.get('/users/1')).resolves.toEqual({ wrapped: true });
  });
});

describe('超时与取消', () => {
  it('超时抛 TIMEOUT', async () => {
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: pendingFetch });

    await expect(client.get('/slow', { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 0,
    });
  });

  it('主动取消抛 ABORTED 而非 TIMEOUT', async () => {
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: pendingFetch });
    const controller = new AbortController();

    const promise = client.get('/slow', { signal: controller.signal, timeoutMs: 1000 });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('超时中断后释放定时器，请求结束后不再触发', async () => {
    const calls: string[] = [];
    const stub = createFetchStub(() => {
      calls.push('sent');
      return new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 20);
      });
    });
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await expect(client.get('/slow', { timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls).toEqual(['sent']);
  });
});
