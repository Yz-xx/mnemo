import type {
  BaseUrlLike,
  HttpDefaults,
  HttpErrorInterceptor,
  HttpMethod,
  HttpParams,
  HttpRequestConfig,
  HttpRequestInterceptor,
  HttpResponse,
  HttpResponseInterceptor,
  HttpResponseType,
} from './types.js';
import { toErrorMessage } from '../common.js';
import { normalizeBody } from './body.js';
import { HttpError, isHttpError } from './errors.js';
import { parseErrorBody, parseResponse, pickErrorMessage } from './parse.js';
import { createTimeoutSignal } from './timeout.js';
import { buildUrl } from './url.js';

/** 执行链的注入项：fetch 与 token 取值器由工厂给出，三个拦截器读口让注册后立即生效 */
export interface ExecutorDeps {
  fetch: typeof fetch;
  getToken: () => string | null;
  requestInterceptors: () => readonly HttpRequestInterceptor[];
  responseInterceptors: () => readonly HttpResponseInterceptor[];
  errorInterceptors: () => readonly HttpErrorInterceptor[];
}

/** 可发送的配置：各可选项都已落到有效值 */
interface ResolvedRequest {
  url: string;
  method: HttpMethod;
  baseURL: BaseUrlLike | undefined;
  params?: HttpParams;
  headers: Record<string, string>;
  body?: unknown;
  responseType: HttpResponseType;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 合并实例默认值：默认头先铺开、单次配置覆盖其上，其余字段取「单次优先、实例兜底」 */
function mergeConfig(config: HttpRequestConfig, defaults: HttpDefaults): HttpRequestConfig {
  return {
    ...config,
    baseURL: config.baseURL ?? defaults.baseURL,
    method: config.method ?? 'GET',
    responseType: config.responseType ?? 'json',
    timeoutMs: config.timeoutMs ?? defaults.timeoutMs,
    headers: { ...defaults.headers, ...config.headers },
  };
}

/** 拦截器可能把字段改回 undefined，故发送前再兜一次默认（幂等，重复兜底无害） */
function resolveRequest(config: HttpRequestConfig): ResolvedRequest {
  return {
    url: config.url,
    method: config.method ?? 'GET',
    baseURL: config.baseURL,
    params: config.params,
    headers: config.headers ?? {},
    body: config.body,
    responseType: config.responseType ?? 'json',
    timeoutMs: config.timeoutMs ?? 0,
    signal: config.signal,
  };
}

/** 头名大小写不敏感：调用方可能写 `content-type` 也可能写 `Content-Type`，不区分会重复发同名头 */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** 合成最终请求头：默认头 → 单次配置 → 补 Content-Type 与 Authorization（已存在则不覆盖） */
function buildHeaders(
  headers: Record<string, string>,
  contentType: string | undefined,
  token: string | null,
): Record<string, string> {
  const merged = { ...headers };
  if (contentType && !hasHeader(merged, 'content-type')) merged['Content-Type'] = contentType;
  if (token && !hasHeader(merged, 'authorization')) merged.Authorization = `Bearer ${token}`;
  return merged;
}

/** 非 2xx 归一化：错误体尽力解析后带上，状态码保留原始值以便定位（不做契约收敛） */
async function toResponseError(raw: Response): Promise<HttpError> {
  const data = await parseErrorBody(raw);
  return new HttpError({
    code: 'HTTP_ERROR',
    status: raw.status,
    message: pickErrorMessage(data, raw.status),
    data,
    response: { data, status: raw.status, headers: raw.headers, raw },
  });
}

/**
 * 传输类错误归类。
 * 超时与主动取消都表现为 AbortError，只有 `timedOut` 能分出前者，
 * 否则调用方会把「用户取消」误报成「请求超时」。
 */
function normalizeSendError(error: unknown, timedOut: boolean, config: ResolvedRequest): HttpError {
  // 已经归一化的错误（HTTP_ERROR / PARSE_ERROR）原样透传，不二次包装
  if (isHttpError(error)) return error;
  if (timedOut) {
    return new HttpError({
      code: 'TIMEOUT',
      message: `请求超时（${config.timeoutMs}ms）`,
      cause: error,
    });
  }
  if (config.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new HttpError({ code: 'ABORTED', message: '请求已取消', cause: error });
  }
  return new HttpError({ code: 'NETWORK_ERROR', message: toErrorMessage(error), cause: error });
}

/** 拦截器链之外逃逸出的异常也兜成 HttpError，保证调用方只需处理一种错误类型 */
function toFallbackError(error: unknown): HttpError {
  return new HttpError({ code: 'NETWORK_ERROR', message: toErrorMessage(error), cause: error });
}

/**
 * 发送并解析。
 * 超时信号覆盖「发送 + 读体」整段：提前释放定时器会让慢响应体不再受超时约束，
 * 所以只在 finally 里释放，而不是 fetch 返回后。
 */
async function send<T>(config: ResolvedRequest, deps: ExecutorDeps): Promise<HttpResponse<T>> {
  const timeout = createTimeoutSignal(config.timeoutMs, config.signal);
  const { body, contentType } = normalizeBody(config.body);
  const headers = buildHeaders(config.headers, contentType, deps.getToken());
  const url = buildUrl(config.baseURL, config.url, config.params);

  try {
    const raw = await deps.fetch(url, {
      method: config.method,
      headers,
      body,
      signal: timeout.signal,
    });
    if (!raw.ok) throw await toResponseError(raw);
    const data = await parseResponse<T>(raw, config.responseType);
    return { data, status: raw.status, headers: raw.headers, raw };
  } catch (error) {
    throw normalizeSendError(error, timeout.isTimedOut(), config);
  } finally {
    timeout.dispose();
  }
}

/** 请求拦截器逆序执行：后注册者最后改写配置，即离发送最近（axios 同口径） */
async function runRequestInterceptors(
  config: HttpRequestConfig,
  handlers: readonly HttpRequestInterceptor[],
): Promise<HttpRequestConfig> {
  let current = config;
  for (const handler of [...handlers].reverse()) {
    current = await handler(current);
  }
  return current;
}

/** 响应拦截器按注册顺序执行：与请求方向相反，形成「层层包裹」的对称结构 */
async function runResponseInterceptors(
  response: HttpResponse,
  handlers: readonly HttpResponseInterceptor[],
): Promise<HttpResponse> {
  let current = response;
  for (const handler of handlers) {
    current = await handler(current);
  }
  return current;
}

/** 错误拦截器按注册顺序执行；返回 HttpResponse 即「已恢复」并作为结果返回，否则带着新的 HttpError 继续 */
async function runErrorInterceptors(
  error: unknown,
  handlers: readonly HttpErrorInterceptor[],
): Promise<HttpResponse> {
  let current = isHttpError(error) ? error : toFallbackError(error);
  for (const handler of handlers) {
    const result = await handler(current);
    if (isHttpError(result)) {
      current = result;
      continue;
    }
    return result;
  }
  throw current;
}

/**
 * 创建单次请求的执行链：合并默认值 → 请求拦截器 → 发送解析 → 响应拦截器，
 * 任一步抛错都交给错误拦截器收口。
 */
export function createExecutor(
  deps: ExecutorDeps,
): (config: HttpRequestConfig, defaults: HttpDefaults) => Promise<HttpResponse<unknown>> {
  return async function execute(config, defaults) {
    try {
      const merged = mergeConfig(config, defaults);
      const intercepted = await runRequestInterceptors(merged, deps.requestInterceptors());
      const response = await send<unknown>(resolveRequest(intercepted), deps);
      return await runResponseInterceptors(response, deps.responseInterceptors());
    } catch (error) {
      return await runErrorInterceptors(error, deps.errorInterceptors());
    }
  };
}
