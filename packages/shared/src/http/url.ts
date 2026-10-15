import type { BaseUrlLike, HttpParams } from './types.js';

/** 取值器每次请求时求值：地址可由用户在设置里切换，实例因此能长期持有而不必重建 */
export function resolveBaseUrl(baseURL: BaseUrlLike | undefined): string {
  if (!baseURL) return '';
  return typeof baseURL === 'function' ? baseURL() : baseURL;
}

// 只保留到「scheme://」为止，用于判断传入的 url 是否已是绝对地址
const ABSOLUTE_URL = /^[a-z][\w+\-.]*:\/\//i;

/** 拼接基础地址与路径：两端多余的斜杠只留一个；url 本身是绝对地址时忽略 baseURL */
export function joinUrl(baseURL: string, url: string): string {
  if (!baseURL || ABSOLUTE_URL.test(url)) return url;
  return `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/** 序列化查询参数：`undefined` / `null` 跳过，数组按重复键展开；无有效参数返回空串 */
export function buildQuery(params?: HttpParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
      continue;
    }
    search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/**
 * 组装最终请求地址。
 * url 自带查询串时用 `&` 续接，避免拼出两个 `?`（否则服务端会把第二段当成参数值的一部分）。
 */
export function buildUrl(
  baseURL: BaseUrlLike | undefined,
  url: string,
  params?: HttpParams,
): string {
  const query = buildQuery(params);
  const withQuery =
    query && url.includes('?') ? `${url}${query.replace('?', '&')}` : `${url}${query}`;
  return joinUrl(resolveBaseUrl(baseURL), withQuery);
}
