// http 模块的统一出口。
// 只导出「调用方必须知道的事实」：公共类型面在 types.ts、错误模型在 errors.ts、工厂在 client.ts。
// 内部实现（execute / parse / url / body / timeout / interceptors）刻意不导出——
// 它们坐在接口背后，暴露出去只会让调用方依赖不属于接口的东西。
export type {
  BaseUrlLike,
  HttpClient,
  HttpClientInterceptors,
  HttpClientOptions,
  HttpDefaults,
  HttpErrorInterceptor,
  HttpErrorResult,
  HttpInterceptors,
  HttpMethod,
  HttpMethodConfig,
  HttpParamValue,
  HttpParams,
  HttpRequestConfig,
  HttpRequestInterceptor,
  HttpResponse,
  HttpResponseInterceptor,
  HttpResponseType,
  InterceptorManager,
} from './types.js';
export type { HttpErrorCode, HttpErrorInit } from './errors.js';
export { HttpError, isHttpError } from './errors.js';
export { createHttpClient } from './client.js';
