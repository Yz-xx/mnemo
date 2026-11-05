import type { ChatStreamFrame } from '../api/client';
import type { ChatCitation } from '../types';
import { describe, expect, it } from 'vitest';
import { consumeChatStream, createMessage } from '../composables/chatStream';

/** 构造一条测试引用：本组只关心文档 ID 与标题，其余字段取固定值 */
function cite(documentId: string, title: string): ChatCitation {
  return { documentId, chunkId: `${documentId}-c1`, title, page: null, snippet: '', score: 0.9 };
}

/** 一次性消费给定的帧序列，回调只做空实现：本组用例只断言消息字段 */
async function consume(frames: ChatStreamFrame[]) {
  const message = createMessage('assistant', '');
  const stream = (async function* () {
    for (const frame of frames) yield frame;
  })();

  await consumeChatStream(stream, message, {
    onSeq: () => {},
    onConversation: () => {},
    onDone: async () => {},
    onError: () => {},
  });
  return message;
}

describe('consumeChatStream 检索来源', () => {
  it('终局 sources 事件覆盖检索过程中累积的引用，剔除未被引用的文档', async () => {
    const used = cite('d1', '公共手册');
    const message = await consume([
      { seq: 1, event: { type: 'source', citation: used } },
      { seq: 2, event: { type: 'source', citation: cite('d2', '我的笔记') } },
      { seq: 3, event: { type: 'sources', citations: [used] } },
      { seq: 4, event: { type: 'done', conversationId: 'c-1', title: '问答' } },
    ]);

    expect(message.sources).toEqual([used]);
  });

  it('同一文档被多次命中时只登记一条引用', async () => {
    const message = await consume([
      { seq: 1, event: { type: 'source', citation: cite('d1', '公共手册') } },
      { seq: 2, event: { type: 'source', citation: cite('d1', '公共手册') } },
    ]);

    expect(message.sources).toEqual([cite('d1', '公共手册')]);
  });

  it('终局来源为空时移除引用，不留下空数组', async () => {
    const message = await consume([
      { seq: 1, event: { type: 'source', citation: cite('d1', '公共手册') } },
      { seq: 2, event: { type: 'sources', citations: [] } },
    ]);

    expect(message.sources).toBeUndefined();
  });
});
