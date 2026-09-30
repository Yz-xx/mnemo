import type { ChatStreamEvent } from './chat.js';
import type { HttpStatusCode } from './http.js';
import { HTTP_STATUS, toHttpStatusCode } from './http.js';

/**
 * 注入式 HTTP 客户端工厂：藏住请求头拼装、错误归一化、SSE 流解析三段共性逻辑，
 * 调用方只需注入 baseURL 与 token 获取器即可拿到一个可复用的客户端实例。
 *
 * baseURL 与 getToken 都设计为注入式（请求发起时才调用）而非构造期固化：
 * 桌面端 useAuth 的 token 是模块级单例、地址可由用户在设置里切换，admin 网站用 localStorage，
 * 三者都希望"地址或 token 变化无需重建实例"——把取值时机推迟到请求发起时，
 * 客户端实例可长期持有，调用方不必再维护 computed 重建。
 * baseURL 仍接受裸字符串：地址固定的调用方（如 admin 网站的 server.proxy 同源方案）照旧传值即可。
 *
 * 仅依赖运行时内置 fetch / FormData / Response / ReadableStream（Node 18+ 与浏览器均内置），
 * 不引入第三方包，故放本包根而非子路径，保留 sideEffects: false 以利 tree-shaking。
 */

/**
 * 带 HTTP 状态码的请求错误：调用方据此识别 401（登录失效）等需要特殊处理的情况。
 * 状态码经 toHttpStatusCode 收敛到契约取值，网关/代理注入的契约外码统一按 500 处理。
 * `message` 可能带服务端返回的真实状态码（如「请求失败（HTTP 403）」），与收敛后的
 * `status` 刻意不一致：前者要可定位，后者要能安全地按契约分支，不要当成 bug 去对齐。
 */
export class ApiError extends Error {
  constructor(
    readonly status: HttpStatusCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 是否为登录失效错误：调用方据此清登录态并回到登录页 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === HTTP_STATUS.UNAUTHORIZED;
}

/** 请求选项：方法、请求体、额外头、中断信号 */
export interface RequestOptions {
  method?: string;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** 请求目标地址：固定字符串或每次请求时实时取值的函数（支持运行期切换地址而无需重建实例） */
export type BaseUrlLike = string | (() => string);

/** 工厂注入项 */
export interface ApiClientOptions {
  baseURL: BaseUrlLike;
  /** 每次请求时实时取 token；返回空串或 null 表示未登录，不发 Authorization */
  getToken?: () => string | null;
  /** 401 时调用一次，调用方据此清登录态与重置业务状态；不在工厂内跳路由，路由策略由调用方决定 */
  onUnauthorized?: () => void;
}

/** 统一取出请求目标地址：字符串直用，取值器每次请求时求值 */
function resolveBaseURL(baseURL: BaseUrlLike): string {
  return typeof baseURL === 'function' ? baseURL() : baseURL;
}

/** 客户端实例：三段能力的最小接口 */
export interface ApiClient {
  /** 通用 JSON 请求；204 直接返回 undefined 不解析响应体 */
  request<T>(path: string, init?: RequestOptions): Promise<T>;
  /** 流式 SSE 请求；逐块解析 `data:` 行并 yield 结构化事件 */
  streamSSE(path: string, init?: RequestOptions): AsyncGenerator<ChatStreamEvent>;
  /** 下载二进制；返回 Blob 由调用方按需取 arrayBuffer / text */
  downloadBlob(path: string, init?: RequestOptions): Promise<Blob>;
}

/**
 * 统一构造请求头：
 * - FormData 的 Content-Type 必须由运行时生成（multipart boundary），手写会破坏解析
 * - token 实时取，未登录则不发 Authorization
 */
function buildHeaders(
  getToken: () => string | null,
  body: BodyInit | null | undefined,
  extra?: Record<string, string>,
): Record<string, string> {
  const token = getToken() ?? '';
  return {
    ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/** 尽量取出服务端返回的 message 字段，取不到时退化为状态码提示 */
async function extractError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? `请求失败（HTTP ${res.status}）`;
  } catch {
    return `请求失败（HTTP ${res.status}）`;
  }
}

/** 包装错误：转 ApiError + 401 触发回调，避免在三个调用点重复 */
async function throwApiError(res: Response, onUnauthorized?: () => void): Promise<never> {
  const message = await extractError(res);
  const err = new ApiError(toHttpStatusCode(res.status), message);
  if (err.status === HTTP_STATUS.UNAUTHORIZED) onUnauthorized?.();
  throw err;
}

/** 创建一个可复用的 HTTP 客户端实例；token 取值时机推迟到请求发起时，实例可长期持有 */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  const { baseURL, getToken = () => null, onUnauthorized } = opts;

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const res = await fetch(`${resolveBaseURL(baseURL)}${path}`, {
      method: init.method,
      body: init.body,
      headers: buildHeaders(getToken, init.body, init.headers),
      signal: init.signal,
    });
    if (!res.ok) await throwApiError(res, onUnauthorized);
    if (res.status === HTTP_STATUS.NO_CONTENT) return undefined as T;
    return (await res.json()) as T;
  }

  async function* streamSSE(
    path: string,
    init: RequestOptions = {},
  ): AsyncGenerator<ChatStreamEvent> {
    const res = await fetch(`${resolveBaseURL(baseURL)}${path}`, {
      method: init.method,
      body: init.body,
      headers: buildHeaders(getToken, init.body, init.headers),
      signal: init.signal,
    });
    if (!res.ok) await throwApiError(res, onUnauthorized);
    if (!res.body) {
      throw new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, '响应无内容流');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // SSE 事件以空行分隔；最后一段可能被截断，保留到下一轮再拼
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (raw) yield JSON.parse(raw) as ChatStreamEvent;
      }
    }
  }

  async function downloadBlob(path: string, init: RequestOptions = {}): Promise<Blob> {
    const res = await fetch(`${resolveBaseURL(baseURL)}${path}`, {
      method: init.method,
      body: init.body,
      headers: buildHeaders(getToken, init.body, init.headers),
      signal: init.signal,
    });
    if (!res.ok) await throwApiError(res, onUnauthorized);
    return res.blob();
  }

  return { request, streamSSE, downloadBlob };
}
