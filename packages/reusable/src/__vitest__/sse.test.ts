import type { ChatStreamFrame } from '../chat.js';
import { describe, expect, it } from 'vitest';
import { parseSSEStream } from '../sse.js';

/** 把若干字符串分块拼成响应体流：分块边界与事件边界错开，才测得到跨块拼装 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** 消费整条事件流，便于断言产出顺序 */
async function collect(chunks: string[]): Promise<ChatStreamFrame[]> {
  const frames: ChatStreamFrame[] = [];
  for await (const frame of parseSSEStream(streamOf(chunks))) frames.push(frame);
  return frames;
}

const TOKEN_FRAME = 'id: 1\ndata: {"type":"token","content":"你好"}\n\n';
const DONE_FRAME = 'id: 2\ndata: {"type":"done","conversationId":"c1","title":"标题"}\n\n';

describe('parseSSEStream', () => {
  it('正常路径：一块内多条事件按原顺序产出，并带上服务端序号', async () => {
    expect(await collect([`${TOKEN_FRAME}${DONE_FRAME}`])).toEqual([
      { seq: 1, event: { type: 'token', content: '你好' } },
      { seq: 2, event: { type: 'done', conversationId: 'c1', title: '标题' } },
    ]);
  });

  it('边界：一条事件被切成三块时，攒到空行才产出', async () => {
    const frames = await collect(['id: 1\ndata: {"type":"tok', 'en","content":"跨', '块"}\n\n']);
    expect(frames).toEqual([{ seq: 1, event: { type: 'token', content: '跨块' } }]);
  });

  it('边界：分块切点落在多字节字符中间也能还原（TextDecoder 流式解码）', async () => {
    const encoder = new TextEncoder();
    const prefix = 'id: 1\ndata: {"type":"token","content":"';
    const bytes = encoder.encode(`${prefix}你好"}\n\n`);
    // 切点落在「你」的三个字节之间，逼出 decoder 的 stream 分支
    const cut = encoder.encode(prefix).length + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });

    const frames: ChatStreamFrame[] = [];
    for await (const frame of parseSSEStream(stream)) frames.push(frame);
    expect(frames).toEqual([{ seq: 1, event: { type: 'token', content: '你好' } }]);
  });

  it('忽略非 data 行（心跳 / 注释）与空 data 行', async () => {
    const frames = await collect([': keep-alive\n\n', 'event: ping\n\n', 'data:\n\n', TOKEN_FRAME]);
    expect(frames).toEqual([{ seq: 1, event: { type: 'token', content: '你好' } }]);
  });

  it('缺 id 行时退回本地递增序号（兼容旧服务端）', async () => {
    const frames = await collect([
      'data: {"type":"token","content":"甲"}\n\n',
      'data: {"type":"token","content":"乙"}\n\n',
    ]);
    expect(frames).toEqual([
      { seq: 1, event: { type: 'token', content: '甲' } },
      { seq: 2, event: { type: 'token', content: '乙' } },
    ]);
  });

  it('流结束前最后一段不完整时（无空行收尾）不产出半截事件', async () => {
    expect(await collect([TOKEN_FRAME, 'id: 2\ndata: {"type":"done","conversa'])).toEqual([
      { seq: 1, event: { type: 'token', content: '你好' } },
    ]);
  });
});
