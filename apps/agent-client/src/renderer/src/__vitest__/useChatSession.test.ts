import type { ChatMessage, Conversation } from '../types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useChatSession } from '../composables/useChatSession';

// 会话切换的响应竞态：先发出的请求可能后到达。
// 只认最后一次切换发出的请求，否则界面会把旧会话的内容显示在新建或后选的会话上。

const api = vi.hoisted(() => ({
  getConversation: vi.fn(),
  listConversations: vi.fn(),
  deleteConversation: vi.fn(),
}));

vi.mock('../api/session', () => ({ agentApi: api }));

/** 手动可控的 Promise：让两个切换请求的响应顺序与发出顺序相反 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 构造只含一条用户消息的会话，用消息 id 区分内容来源 */
function conversation(id: string): Conversation {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 1,
    messages: [
      { id: `${id}-msg`, role: 'user', content: id, createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
}

/** 组装被测 hook 与共享状态，返回全部可用于断言的引用 */
function createHarness() {
  const messages = ref<ChatMessage[]>([]);
  const activeId = ref<string | null>(null);
  const streaming = ref(false);
  const errorMessage = ref('');

  const controls = useChatSession({
    messages,
    activeId,
    streaming,
    errorMessage,
    handleUnauthorized: async () => {},
    handleError: async () => {},
    abortStream: () => {},
  });

  return { messages, activeId, streaming, errorMessage, ...controls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('selectConversation 的响应竞态', () => {
  it('先发出但后到达的响应不覆盖后选中的会话', async () => {
    const slow = createDeferred<Conversation>();
    const fast = createDeferred<Conversation>();
    api.getConversation.mockImplementation((id: string) =>
      id === 'a' ? slow.promise : fast.promise,
    );
    const harness = createHarness();

    const selectingA = harness.selectConversation('a');
    const selectingB = harness.selectConversation('b');

    fast.resolve(conversation('b'));
    await selectingB;
    expect(harness.activeId.value).toBe('b');

    slow.resolve(conversation('a'));
    await selectingA;

    expect(harness.activeId.value).toBe('b');
    expect(harness.messages.value.map((message) => message.id)).toEqual(['b-msg']);
  });

  it('历史会话加载中新建对话时，在途响应返回后不覆盖空对话', async () => {
    const pending = createDeferred<Conversation>();
    api.getConversation.mockReturnValue(pending.promise);
    const harness = createHarness();

    const selecting = harness.selectConversation('a');
    harness.startNewConversation();
    pending.resolve(conversation('a'));
    await selecting;

    expect(harness.activeId.value).toBeNull();
    expect(harness.messages.value).toEqual([]);
    expect(harness.loading.value).toBe(false);
  });

  it('历史会话加载中登出清空会话时，在途响应返回后不写回上一个账号的内容', async () => {
    const pending = createDeferred<Conversation>();
    api.getConversation.mockReturnValue(pending.promise);
    const harness = createHarness();

    const selecting = harness.selectConversation('a');
    harness.clearSession();
    pending.resolve(conversation('a'));
    await selecting;

    expect(harness.activeId.value).toBeNull();
    expect(harness.messages.value).toEqual([]);
    expect(harness.loading.value).toBe(false);
  });
});
