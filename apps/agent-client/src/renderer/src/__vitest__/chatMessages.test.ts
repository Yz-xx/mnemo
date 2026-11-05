import type { ChatStreamFrame } from '../api/client';
import type { ChatMessage } from '../types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useChatMessages } from '../composables/useChatMessages';

// 中断路径的回归用例：客户端 abort 后通常收不到 done 帧，
// 收尾时若不刷新会话列表，刚生成的会话要等下一轮成功对话才出现在侧边栏。

const api = vi.hoisted(() => ({
  streamChat: vi.fn(),
  resumeChat: vi.fn(),
  stopRound: vi.fn(() => Promise.resolve()),
  getConversation: vi.fn(),
}));

vi.mock('../api/session', () => ({ agentApi: api }));
vi.mock('../api/bridge', () => ({ saveFile: vi.fn() }));

/** 可中断的假聊天流：先推会话 ID 与一段正文，随后挂起直到客户端中断 */
function createInterruptedStream(signal: AbortSignal): AsyncGenerator<ChatStreamFrame> {
  return (async function* () {
    yield { seq: 1, event: { type: 'conversation', conversationId: 'c-1' } };
    yield { seq: 2, event: { type: 'token', content: '部分回答' } };
    await new Promise<void>((resolve) => {
      // 中断可能早于监听注册：先判一次已中断，避免挂起永不结束
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();
}

/** 只挂起、不产出任何帧的假聊天流：用于构造「首个产出之前就被中断」的场景 */
function createPendingStream(signal: AbortSignal): AsyncIterable<ChatStreamFrame> {
  return {
    [Symbol.asyncIterator]() {
      return {
        // 挂起到客户端中断为止，随后正常结束且不产出任何帧
        next: async (): Promise<IteratorResult<ChatStreamFrame>> => {
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** 组装被测 hook 与共享状态，返回全部可用于断言的引用 */
function createHarness(refreshConversations: () => Promise<void>) {
  const messages = ref<ChatMessage[]>([]);
  const streaming = ref(false);
  const activeId = ref<string | null>(null);
  const errorMessage = ref('');
  // 新会话的选库状态：本组用例不关心绑定，置空即沿用「不限库」旧行为
  const selectedKnowledgeBaseId = ref<string | null>(null);

  const controls = useChatMessages({
    messages,
    streaming,
    activeId,
    errorMessage,
    isOnline: () => true,
    refreshConversations,
    takeReadyAttachments: () => ({ names: [], fileIds: [] }),
    selectedKnowledgeBaseId,
    handleError: async () => {},
  });

  return { messages, streaming, activeId, errorMessage, ...controls };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 合帧写入器默认走 rAF，测试环境没有帧时钟，用手动宏任务代替
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) =>
    clearTimeout(handle),
  );
  api.stopRound.mockImplementation(() => Promise.resolve());
});

describe('sendMessage 收尾时的会话列表刷新', () => {
  it('已产出内容后主动中断：收尾时刷新列表，中断的会话立刻可见', async () => {
    const refreshConversations = vi.fn(async () => {});
    api.streamChat.mockImplementation((_payload: unknown, signal: AbortSignal) =>
      createInterruptedStream(signal),
    );
    const harness = createHarness(refreshConversations);

    const sending = harness.sendMessage('你好');
    await vi.waitFor(() => expect(harness.activeId.value).toBe('c-1'));
    harness.stopStreaming();
    await sending;

    expect(refreshConversations).toHaveBeenCalledTimes(1);
  });

  it('正常完成时只刷新一次，不因 done 与收尾各刷一遍而重复请求', async () => {
    const refreshConversations = vi.fn(async () => {});
    api.streamChat.mockImplementation(async function* () {
      yield { seq: 1, event: { type: 'conversation', conversationId: 'c-1' } };
      yield { seq: 2, event: { type: 'token', content: '完整回答' } };
      yield { seq: 3, event: { type: 'done', conversationId: 'c-1', title: '问答' } };
    });
    const harness = createHarness(refreshConversations);

    await harness.sendMessage('你好');

    expect(refreshConversations).toHaveBeenCalledTimes(1);
  });

  it('首个产出前就中断时不刷新，避免展示随后会被回滚的空会话', async () => {
    const refreshConversations = vi.fn(async () => {});
    api.streamChat.mockImplementation((_payload: unknown, signal: AbortSignal) =>
      createPendingStream(signal),
    );
    const harness = createHarness(refreshConversations);

    const sending = harness.sendMessage('你好');
    await vi.waitFor(() => expect(harness.streaming.value).toBe(true));
    harness.stopStreaming();
    await sending;

    expect(refreshConversations).not.toHaveBeenCalled();
  });
});
