// 测试替身：注入 createHttpClient 的 fetch 走的是正式接缝，
// 因此用例既不联网也不 mock 全局 fetch，还能断言实际发出的地址与请求头。

/** 可控 fetch 替身：记录每次调用的入参，响应由调用方给出的 handler 决定 */
export interface FetchStub {
  fetch: typeof fetch;
  /** 按调用顺序记录的入参 */
  calls: { url: string; init: RequestInit }[];
}

export function createFetchStub(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchStub {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const requestInit = init ?? {};
      calls.push({ url, init: requestInit });
      return respond(url, requestInit);
    },
  };
}

/** 构造 JSON 响应：默认 200，让各用例只关心自己那一段 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 204 响应：按规范不能带响应体，构造时必须传 null */
export function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

/** 永不自行结束的 fetch：只响应中断信号，用于验证超时与主动取消 */
export const pendingFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = (): void => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    // 传入时已中断要立刻拒绝：真实 fetch 就是这个行为，只挂事件监听会漏掉「取消早于发送」这一档
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort);
  });
