import type { ChatStreamEvent } from './chat.js';

/**
 * 把 SSE 响应体流解析为结构化对话事件流。
 *
 * 只收「已拿到的字节流」，不碰 fetch / token / 错误归一化：分帧是对话协议的事实，
 * 传输与鉴权是通用 HTTP 库（@repo/shared）的职责。两件事拆开后，本函数可用一段
 * 手工构造的流单测，调用方也只需自己决定「怎么发请求、怎么处理非 2xx」。
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent> {
  const reader = stream.getReader();
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
