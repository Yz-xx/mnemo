import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../../http/index.js';
import { createFetchStub, jsonResponse, noContentResponse } from './helpers.js';

describe('响应解析', () => {
  it('默认只返回解析后的 data', async () => {
    const stub = createFetchStub(() => jsonResponse({ id: 1 }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await expect(client.get('/users/1')).resolves.toEqual({ id: 1 });
  });

  it('returnFullResponse 返回完整响应', async () => {
    const stub = createFetchStub(() => jsonResponse({ id: 1 }, 201));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    const response = await client.get<{ id: number }>('/users', { returnFullResponse: true });

    expect(response.status).toBe(201);
    expect(response.data).toEqual({ id: 1 });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.raw).toBeInstanceOf(Response);
  });

  it('requestRaw 始终返回完整响应', async () => {
    const stub = createFetchStub(() => jsonResponse({ id: 1 }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    const response = await client.requestRaw<{ id: number }>({ url: '/users/1' });

    expect(response.data).toEqual({ id: 1 });
    expect(response.status).toBe(200);
  });

  it('204 返回 undefined 且不解析响应体', async () => {
    const stub = createFetchStub(() => noContentResponse());
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await expect(client.delete('/users/1')).resolves.toBeUndefined();
  });

  it('responseType text / arrayBuffer / stream 交出对应形态', async () => {
    const stub = createFetchStub((url) => {
      if (url.endsWith('/text')) return new Response('纯文本');
      if (url.endsWith('/bytes')) return new Response(new Uint8Array([1, 2]));
      return new Response(new ReadableStream({ start: (controller) => controller.close() }));
    });
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await expect(client.get<string>('/text', { responseType: 'text' })).resolves.toBe('纯文本');
    const buffer = await client.get<ArrayBuffer>('/bytes', { responseType: 'arrayBuffer' });
    expect(buffer.byteLength).toBe(2);
    await expect(
      client.get<ReadableStream>('/stream', { responseType: 'stream' }),
    ).resolves.toBeInstanceOf(ReadableStream);
  });

  it('响应体不是合法 JSON 时抛 PARSE_ERROR', async () => {
    const stub = createFetchStub(
      () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
    );
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    await expect(client.get('/broken')).rejects.toMatchObject({ code: 'PARSE_ERROR', status: 200 });
  });

  it('修改 defaults 立即对后续请求生效', async () => {
    const stub = createFetchStub(() => jsonResponse({ ok: true }));
    const client = createHttpClient({ baseURL: 'https://api.test', fetch: stub.fetch });

    client.defaults.baseURL = 'https://changed.test';
    client.defaults.headers['X-Env'] = 'prod';
    await client.get('/users');

    expect(stub.calls[0].url).toBe('https://changed.test/users');
    expect(stub.calls[0].init.headers).toMatchObject({ 'X-Env': 'prod' });
  });
});
