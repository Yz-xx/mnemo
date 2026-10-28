import type { ChatStreamFrame } from '../api/client';
import { describe, expect, it } from 'vitest';
import { consumeChatStream, createMessage } from '../composables/chatStream';

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
  it('终局 sources 事件覆盖检索过程中累积的标签，剔除未被引用的文档', async () => {
    const message = await consume([
      { seq: 1, event: { type: 'source', name: '公共手册' } },
      { seq: 2, event: { type: 'source', name: '我的笔记' } },
      { seq: 3, event: { type: 'sources', names: ['公共手册'] } },
      { seq: 4, event: { type: 'done', conversationId: 'c-1', title: '问答' } },
    ]);

    expect(message.sources).toEqual(['公共手册']);
  });

  it('终局来源为空时移除标签，不留下空数组', async () => {
    const message = await consume([
      { seq: 1, event: { type: 'source', name: '公共手册' } },
      { seq: 2, event: { type: 'sources', names: [] } },
    ]);

    expect(message.sources).toBeUndefined();
  });
});
