import type { HttpResponseType } from './types.js';
import { HttpError } from './errors.js';

/** HTTP 协议级常量（与业务契约无关）：204 表示成功且无响应体 */
const NO_CONTENT = 204;

/**
 * 按 responseType 解析响应体。
 * `204` 与 `none` 一律返回 `undefined`：此时解析只会抛错，没有语义可给。
 */
export async function parseResponse<T>(raw: Response, responseType: HttpResponseType): Promise<T> {
  if (responseType === 'none' || raw.status === NO_CONTENT) return undefined as T;
  switch (responseType) {
    case 'text':
      return (await raw.text()) as T;
    case 'blob':
      return (await raw.blob()) as T;
    case 'arrayBuffer':
      return (await raw.arrayBuffer()) as T;
    case 'stream':
      if (!raw.body) {
        throw new HttpError({
          code: 'HTTP_ERROR',
          status: raw.status,
          message: '响应无内容流',
        });
      }
      // 原样交出未消费的流：分帧（如 SSE 的 data: 行）属消费方协议，通用库不替它决定
      return raw.body as T;
    case 'json':
    default:
      return await parseJson<T>(raw);
  }
}

/**
 * JSON 解析走 `text()` 再 `JSON.parse`，而不是 `raw.json()`：
 * 需要「空响应体 → undefined」这一档语义（如 200 但无内容），而 `raw.json()` 在空体时直接抛错。
 */
async function parseJson<T>(raw: Response): Promise<T> {
  const text = await raw.text();
  if (!text) return undefined as T;
  try {
    // JSON.parse 的结果是外部不可信输入，收窄断言在此豁免（边界处理）
    return JSON.parse(text) as T;
  } catch (error) {
    throw new HttpError({
      code: 'PARSE_ERROR',
      status: raw.status,
      message: '响应体不是合法 JSON',
      data: text,
      cause: error,
    });
  }
}

/** 尽量取出服务端返回的错误体：优先按 JSON 解析，退化为纯文本，再失败留 `undefined` */
export async function parseErrorBody(raw: Response): Promise<unknown> {
  try {
    const contentType = raw.headers.get('content-type') ?? '';
    if (contentType.includes('json')) return await raw.json();
    const text = await raw.text();
    return text || undefined;
  } catch {
    // 错误体解析失败不能掩盖原始状态码，所以吞掉异常、把 data 留空
    return undefined;
  }
}

/** 从错误体里取出可展示的文案；取不到时退化为状态码提示，保证调用方总有东西可展示 */
export function pickErrorMessage(data: unknown, status: number): string {
  if (data && typeof data === 'object' && 'message' in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return `请求失败（HTTP ${status}）`;
}
