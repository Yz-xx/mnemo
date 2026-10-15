import type {
  HttpClient,
  HttpClientInterceptors,
  HttpClientOptions,
  HttpDefaults,
  HttpErrorInterceptor,
  HttpMethodConfig,
  HttpRequestConfig,
  HttpRequestInterceptor,
  HttpResponse,
  HttpResponseInterceptor,
} from './types.js';
import { createExecutor } from './execute.js';
import { createInterceptorManager } from './interceptors.js';

/**
 * 创建一个可复用的 HTTP 客户端实例。
 *
 * 实例本身不持有任何"发出请求时的状态"：baseURL 支持取值器、token 每次请求实时取，
 * 因此地址或登录态变化都不需要重建实例——调用方可以把它当模块级单例长期持有。
 */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const defaults: HttpDefaults = {
    baseURL: options.baseURL,
    headers: { ...options.headers },
    // 0 表示不超时，与 HttpRequestConfig.timeoutMs 的口径一致
    timeoutMs: options.timeoutMs ?? 0,
  };

  const requestInterceptors = createInterceptorManager<HttpRequestInterceptor>();
  const responseInterceptors = createInterceptorManager<HttpResponseInterceptor>();
  const errorInterceptors = createInterceptorManager<HttpErrorInterceptor>();

  const execute = createExecutor({
    // 包一层而非直接赋值：避免依赖 this 绑定（浏览器里裸调 window.fetch 会丢 this）；
    // 外层括号不可省——`??` 右侧直接跟箭头函数会被解析成逗号表达式
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    getToken: options.getToken ?? (() => null),
    requestInterceptors: () => requestInterceptors.list(),
    responseInterceptors: () => responseInterceptors.list(),
    errorInterceptors: () => errorInterceptors.list(),
  });

  async function request<T>(config: HttpRequestConfig): Promise<T> {
    // 传副本：请求拦截器会就地改写配置，不能让调用方传进来的对象被改动
    const response = await execute({ ...config }, defaults);
    // returnFullResponse 由调用方表达、不参与发送，拦截器改它不生效
    return (config.returnFullResponse ? response : response.data) as T;
  }

  async function requestRaw<T>(config: HttpRequestConfig): Promise<HttpResponse<T>> {
    return (await execute({ ...config }, defaults)) as HttpResponse<T>;
  }

  function get<T>(url: string, config?: HttpMethodConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'GET' });
  }

  function del<T>(url: string, config?: HttpMethodConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'DELETE' });
  }

  function head<T>(url: string, config?: HttpMethodConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'HEAD' });
  }

  // 内部函数名避开 options：参数 options 已占用该标识符
  function sendOptions<T>(url: string, config?: HttpMethodConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'OPTIONS' });
  }

  function post<T>(url: string, body?: unknown, config?: HttpMethodConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'POST', body });
  }

  function put<T>(url: string, body?: unknown, config?: HttpMethodConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'PUT', body });
  }

  function patch<T>(url: string, body?: unknown, config?: HttpMethodConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'PATCH', body });
  }

  const interceptors: HttpClientInterceptors = {
    request: requestInterceptors,
    response: responseInterceptors,
    error: errorInterceptors,
  };

  return {
    request,
    requestRaw,
    get,
    // 对象字面量的属性名可以用保留字，内部函数名不行
    delete: del,
    head,
    options: sendOptions,
    post,
    put,
    patch,
    defaults,
    interceptors,
  };
}
