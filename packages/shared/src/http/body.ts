/**
 * 请求体归一化后的形态。
 * `contentType` 仅在需要客户端补头时给出：FormData 绝不能补，
 * 它的 Content-Type 要由运行时生成（含 multipart boundary），手写会直接破坏解析。
 */
export interface NormalizedBody {
  body: BodyInit | null;
  contentType?: string;
}

/** 是否已是 fetch 可直接消费的请求体形态（这些类型不能再用 JSON 序列化） */
function isRawBody(body: unknown): body is BodyInit {
  if (typeof body === 'string') return true;
  if (body instanceof FormData) return true;
  if (body instanceof URLSearchParams) return true;
  if (body instanceof Blob) return true;
  if (body instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(body)) return true;
  return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
}

/**
 * 归一化请求体：普通对象自动 JSON 序列化并给出 Content-Type，其余原样透传。
 *
 * 把这一步收进客户端，是为了让调用方不必再手写 `JSON.stringify` 与 Content-Type——
 * 两处手写就有两处漏改，而漏掉 Content-Type 时服务端常按表单解析，
 * 表现为难以定位的 400，是这类封装最该替调用方兜住的一类坑。
 */
export function normalizeBody(body: unknown): NormalizedBody {
  if (body === undefined || body === null) return { body: null };
  if (isRawBody(body)) return { body };
  if (typeof body === 'object') {
    return { body: JSON.stringify(body), contentType: 'application/json' };
  }
  // 数字 / 布尔等原始值按字符串发送，不误补 JSON 头
  return { body: String(body) };
}
