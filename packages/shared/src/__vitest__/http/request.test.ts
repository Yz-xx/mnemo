import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../../http/index.js';
import { createFetchStub, jsonResponse } from './helpers.js';

describe('请求组装', () => {
  it('拼接 baseURL 与路径，并把 params 序列化进查询串', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({ baseURL: 'https://api.test/', fetch: stub.fetch });

    await client.get('/users', {
      params: { page: 1, keyword: 'a b', empty: undefined, tags: ['x', 'y'] },
    });

    expect(stub.calls[0].url).toBe('https://api.test/users?page=1&keyword=a+b&tags=x&tags=y');
  });

  it('url 自带查询串时用 & 续接，不产生第二个问号', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await client.get('/users?role=admin', { params: { page: 2 } });

    expect(stub.calls[0].url).toBe('https://api.test/users?role=admin&page=2');
  });

  it('url 本身是绝对地址时忽略 baseURL', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await client.get('https://other.test/ping');

    expect(stub.calls[0].url).toBe('https://other.test/ping');
  });

  it('别名方法写入对应 method', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await client.patch('/users/1', { name: 'x' });
    await client.delete('/users/1');

    expect(stub.calls.map((call) => call.init.method)).toEqual(['PATCH', 'DELETE']);
  });

  it('普通对象请求体自动 JSON 序列化并补 Content-Type', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await client.post('/users', { name: '张三' });

    expect(stub.calls[0].init.body).toBe('{"name":"张三"}');
    expect(stub.calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('FormData 原样透传且不补 Content-Type', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });
    const form = new FormData();
    form.append('file', 'content');

    await client.post('/upload', form);

    expect(stub.calls[0].init.body).toBe(form);
    expect(stub.calls[0].init.headers).not.toHaveProperty('Content-Type');
  });

  it('实例默认头与单次头合并，单次优先', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({
      baseURL: 'https://api.test',
      headers: { 'X-Trace': 'default', 'X-Env': 'test' },
      fetch: stub.fetch,
    });

    await client.get('/users', { headers: { 'X-Trace': 'override' } });

    expect(stub.calls[0].init.headers).toMatchObject({ 'X-Trace': 'override', 'X-Env': 'test' });
  });

  it('getToken 实时取 token 注入 Authorization；未登录时不注入', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    let token: string | null = null;
    const client = createHttpClient({
      baseURL: 'https://api.test',
      getToken: () => token,
      fetch: stub.fetch,
    });

    await client.get('/users');
    expect(stub.calls[0].init.headers).not.toHaveProperty('Authorization');

    token = 'abc';
    await client.get('/users');
    expect(stub.calls[1].init.headers).toMatchObject({ Authorization: 'Bearer abc' });
  });

  it('已显式提供的 Authorization 不被注入值覆盖', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({
      baseURL: 'https://api.test',
      getToken: () => 'injected',
      fetch: stub.fetch,
    });

    await client.get('/users', { headers: { authorization: 'Basic xyz' } });

    expect(stub.calls[0].init.headers).toMatchObject({ authorization: 'Basic xyz' });
  });
});
