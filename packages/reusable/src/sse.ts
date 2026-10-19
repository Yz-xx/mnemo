import type { ChatStreamEvent, ChatStreamFrame } from './chat.js';

/**
 * 把 SSE 响应体流解析为带序号的对话事件流。
 *
 * 只收「已拿到的字节流」，不碰 fetch / token / 错误归一化：分帧是对话协议的事实，
 * 传输与鉴权是通用 HTTP 库（@repo/shared）的职责。两件事拆开后，本函数可用一段
 * 手工构造的流单测，调用方也只需自己决定「怎么发请求、怎么处理非 2xx」。
 *
 * 每帧序号取自 `id:` 行；旧服务端不下发 `id:` 时退回本地递增计数，使客户端在两种服务端
 * 上都拿到可用的断点位置（只是旧服务端本身不支持真正续传）。
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // 缺 `id:` 行时的兜底序号：与旧服务端的本地帧序保持一致
  let fallbackSeq = 0;
  // SSE 事件以空行分隔；最后一段可能被截断，保留到下一轮再拼
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      const dataLine = lines.find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const raw = dataLine.slice(5).trim();
      if (!raw) continue;
      const idLine = lines.find((line) => line.startsWith('id:'));
      const parsedSeq = idLine ? Number.parseInt(idLine.slice(3).trim(), 10) : Number.NaN;
      if (Number.isNaN(parsedSeq)) {
        // 服务端未给序号：本地递增，至少保证帧序单调可供客户端记录断点
        fallbackSeq += 1;
        yield { seq: fallbackSeq, event: JSON.parse(raw) as ChatStreamEvent };
        continue;
      }
      // 切到带序号的服务端后，让兜底计数跟上，中途混用也不会回退
      fallbackSeq = parsedSeq;
      yield { seq: parsedSeq, event: JSON.parse(raw) as ChatStreamEvent };
    }
  }
}
