// HTTP 客户端的公共类型面：调用方（与测试）需要知道的全部事实都收在这里。
// 实现侧的四段逻辑（地址拼装、请求体序列化、超时、拦截器）刻意不进入本文件——
// 接口面一旦随实现细节一起长大，调用方与测试要学的就与实现一样多，模块也就不再"深"。
import type { HttpError } from './errors.js';

/** HTTP 方法：取大写字面量，与别名方法的默认口径统一 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * 响应解析方式：
 * - `stream` 返回未消费的 `ReadableStream`，协议细节（如 SSE 的分帧）留给消费方自己解析，
 *   通用库不替业务决定「一段流该怎么读」；
 * - `none` 只发请求不看响应体（与 204 等价），返回 `undefined`。
 */
export type HttpResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'stream' | 'none';

/** 请求地址来源：固定字符串，或每次请求时才求值的函数（支持运行期切换地址而不重建实例） */
export type BaseUrlLike = string | (() => string);

/** 单个查询参数值：`undefined` / `null` 表示不携带该键；数组按重复键展开 */
export type HttpParamValue =
  string | number | boolean | null | undefined | readonly (string | number | boolean)[];

/** 查询参数集合 */
export type HttpParams = Record<string, HttpParamValue>;

/** 单次请求配置；未提供的字段回落到实例 `defaults` */
export interface HttpRequestConfig {
  url: string;
  method?: HttpMethod;
  /** 覆盖实例默认地址；不传时用实例 `defaults.baseURL` */
  baseURL?: BaseUrlLike;
  params?: HttpParams;
  headers?: Record<string, string>;
  /** 请求体：普通对象自动 JSON 序列化并补 Content-Type；已序列化类型（FormData / Blob / 流等）原样透传 */
  body?: unknown;
  responseType?: HttpResponseType;
  /** 超时毫秒数；`0` 或省略表示不超时 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 默认 `false`：只返回解析后的 data。置 `true` 则返回完整响应（status / headers / raw） */
  returnFullResponse?: boolean;
}

/**
 * 完整响应：`data` 是按 `responseType` 解析后的结果。
 * `raw` 是逃生口——客户端没封装的能力（如自行读取响应体流）直接用原生 `Response`，
 * 免得为了少数场景把接口面撑大。
 */
export interface HttpResponse<T = unknown> {
  data: T;
  /** 原始状态码。刻意不做契约收敛：把网关注入的契约外码归到哪一档是业务口径，属消费方 */
  status: number;
  headers: Headers;
  raw: Response;
}

/** 请求拦截器：拿到已合并默认值的配置，返回改写后的配置 */
export type HttpRequestInterceptor = (
  config: HttpRequestConfig,
) => HttpRequestConfig | Promise<HttpRequestConfig>;

/** 响应拦截器：可改写响应后交给下一个（含把非 2xx 之外的加工逻辑收在此处） */
export type HttpResponseInterceptor = (
  response: HttpResponse,
) => HttpResponse | Promise<HttpResponse>;

/**
 * 错误拦截器的产出，只允许两种：
 * - 返回 `HttpResponse`：视为「已恢复」，该响应即本次请求的结果；
 * - 返回 `HttpError`：换成这个错误继续沿链抛。
 * 刻意不放任返回任意值：那会让「请求结果」与「错误」在类型上无法区分，
 * 调用方每次都得自己做形状判断。
 */
export type HttpErrorResult = HttpResponse | HttpError;

/** 错误拦截器 */
export type HttpErrorInterceptor = (error: HttpError) => HttpErrorResult | Promise<HttpErrorResult>;

/** 拦截器三钩子 */
export interface HttpInterceptors {
  onRequest?: HttpRequestInterceptor;
  onResponse?: HttpResponseInterceptor;
  onError?: HttpErrorInterceptor;
}

/**
 * 拦截器管理器：调用方只需 `use` / `eject` 两个动作。
 * `list` 是给客户端执行链用的内部读口，不属于调用方接口——
 * 把「注册方向」与「执行方向」分开，执行顺序就只有一个真相来源。
 */
export interface InterceptorManager<H> {
  /** 注册处理器，返回用于移除的 id */
  use(handler: H): number;
  /** 按 id 移除；id 不存在时静默忽略 */
  eject(id: number): void;
  /** 按注册顺序取出全部处理器（内部读口） */
  list(): readonly H[];
}

/** 实例级拦截器注册口，三类的注册方式一致 */
export interface HttpClientInterceptors {
  readonly request: InterceptorManager<HttpRequestInterceptor>;
  readonly response: InterceptorManager<HttpResponseInterceptor>;
  readonly error: InterceptorManager<HttpErrorInterceptor>;
}

/**
 * 实例默认项，可直接改写（axios 的 `defaults` 习惯）：
 * 改这里对所有后续请求立即生效，无需重建实例。
 */
export interface HttpDefaults {
  baseURL: BaseUrlLike | undefined;
  headers: Record<string, string>;
  /** 超时毫秒数，`0` 表示不超时 */
  timeoutMs: number;
}

/**
 * 工厂注入项。
 * `fetch` 可注入是为了让测试用替身走同一个接缝，也让非浏览器环境有适配位置；
 * `getToken` 是鉴权的唯一入口——只有这一处能影响 Authorization 头，
 * 避免「选项注 token」与「拦截器注 token」两个位置并存而互相覆盖。
 */
export interface HttpClientOptions {
  baseURL?: BaseUrlLike;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 每次请求时实时取 token；返回空串或 `null` 表示未登录，此时不发 Authorization */
  getToken?: () => string | null;
  fetch?: typeof fetch;
}

/** 别名方法的可选项：url 与 method 由别名给定，其余照旧可覆盖 */
export type HttpMethodConfig = Omit<HttpRequestConfig, 'url' | 'method'>;

/** 客户端实例 */
export interface HttpClient {
  /**
   * 通用请求；默认返回解析后的 `data`（与既有 `request<T>(path, init)` 的消费方形状一致，
   * 便于后续替换时调用点不用改），`returnFullResponse` 置 `true` 时返回完整响应。
   */
  request<T = unknown>(config: HttpRequestConfig): Promise<T>;
  /** 始终返回完整响应 */
  requestRaw<T = unknown>(config: HttpRequestConfig): Promise<HttpResponse<T>>;
  get<T = unknown>(url: string, config?: HttpMethodConfig): Promise<T>;
  delete<T = unknown>(url: string, config?: HttpMethodConfig): Promise<T>;
  head<T = unknown>(url: string, config?: HttpMethodConfig): Promise<T>;
  options<T = unknown>(url: string, config?: HttpMethodConfig): Promise<T>;
  post<T = unknown>(url: string, body?: unknown, config?: HttpMethodConfig): Promise<T>;
  put<T = unknown>(url: string, body?: unknown, config?: HttpMethodConfig): Promise<T>;
  patch<T = unknown>(url: string, body?: unknown, config?: HttpMethodConfig): Promise<T>;
  /** 可写默认项 */
  defaults: HttpDefaults;
  readonly interceptors: HttpClientInterceptors;
}
