import type { HttpResponse } from './types.js';

/**
 * 错误分类，调用方据此决定重试、提示还是静默处理。
 * 分成五类而非并入一个「请求失败」：它们的处置方式确实不同——
 * 超时与主动取消都会让 fetch 以同一个 AbortError 收尾，只有靠信号来源才能区分开；
 * 响应体解析失败也不是传输问题，混进 NETWORK_ERROR 会指向错误的方向去排查。
 */
export type HttpErrorCode = 'HTTP_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR' | 'ABORTED' | 'PARSE_ERROR';

/** 构造参数用对象而非位置参数：五项里三项可选，位置参数极易传错且读不出意图 */
export interface HttpErrorInit {
  message: string;
  code: HttpErrorCode;
  /** HTTP 状态码；传输类错误（TIMEOUT / NETWORK_ERROR / ABORTED）为 0 */
  status?: number;
  /** 服务端返回的错误体，已尽力解析；解析不出来则留 `undefined`，不影响 status 可定位 */
  data?: unknown;
  response?: HttpResponse;
  /** 原始错误：网络失败的 TypeError 等，保留下来便于追根因 */
  cause?: unknown;
}

/**
 * 请求错误。
 * 只承诺「状态码是一个数字」这一层事实，刻意不收敛成业务契约取值：
 * 契约收敛（如把网关注入的 403 / 502 统一归到 500）是业务侧口径，
 * 放进通用库就等于把某一套业务的约定焊死在这里。
 */
export class HttpError extends Error {
  readonly code: HttpErrorCode;
  readonly status: number;
  readonly data?: unknown;
  readonly response?: HttpResponse;

  constructor(init: HttpErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = 'HttpError';
    this.code = init.code;
    this.status = init.status ?? 0;
    this.data = init.data;
    this.response = init.response;
  }
}

/** 类型守卫：捕获 unknown 后要按错误分支时用（外部不可信输入先收窄再判断，不用 as） */
export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
