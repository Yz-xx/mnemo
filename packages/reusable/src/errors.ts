import { isHttpError } from '@repo/shared';
import { HTTP_STATUS, toHttpStatusCode } from './http.js';

/**
 * 是否为登录失效错误：调用方据此清登录态并回到登录页。
 *
 * 判据刻意经 `toHttpStatusCode` 收敛：状态码来自外部响应，网关或代理可能注入契约外的
 * 403 / 502，直接拿数字比较会把它们误判成「登录失效」。收敛到契约集合后，只有契约定下的
 * 401 才算失效，契约外一律按 500 处理——这正是「状态码契约」这层业务口径存在的意义。
 *
 * 通用 HTTP 库（@repo/shared）只承诺「status 是一个数字」，把 status 收敛成业务契约属
 * 本包的业务约定，故这层判断留在本包而非通用库。
 */
export function isUnauthorized(error: unknown): boolean {
  return isHttpError(error) && toHttpStatusCode(error.status) === HTTP_STATUS.UNAUTHORIZED;
}

/**
 * 是否为「资源不存在」错误：客户端据此把断点续传失败（轮次已过期）降级为重新拉取整条会话。
 *
 * 同样经 `toHttpStatusCode` 收敛：只有契约定下的 404 才算「不存在」，
 * 契约外的状态码一律按 500 处理，避免代理注入的 404 被误当成「轮次没了」。
 */
export function isNotFound(error: unknown): boolean {
  return isHttpError(error) && toHttpStatusCode(error.status) === HTTP_STATUS.NOT_FOUND;
}
