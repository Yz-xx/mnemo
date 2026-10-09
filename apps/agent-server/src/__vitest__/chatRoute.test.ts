import type { AppConfig } from '../configuration/config/index.js';
import type { ConversationStore } from '../conversation/store/index.js';
import type {
  Conversation,
  ConversationSummary,
  MessageMeta,
  MessageRole,
} from '../conversation/types.js';
import type { FileStore, StoredFile } from '../files/store.js';
import type { AgentService } from '../llm/agent.js';
import type { Logger } from '@repo/logger';
import type { AgentStreamEvent, ChatStreamEvent } from '@repo/reusable';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@repo/logger';
import { HTTP_STATUS } from '@repo/reusable';
import { ConversationBusyError } from '../conversation/lock.js';
import { handleChatMessage } from '../routes/client/chat.js';

const USER_ID = 1;

/** 内存版会话存储：替代真实 MySQL，只实现路由层会调用的方法 */
class FakeConversations {
  private readonly records = new Map<string, Conversation>();

  async list(): Promise<ConversationSummary[]> {
    return [...this.records.values()].map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      messageCount: item.messages.length,
    }));
  }

  async get(_userId: number, id: string): Promise<Conversation | null> {
    return this.records.get(id) ?? null;
  }

  async append(
    _userId: number,
    id: string | undefined,
    role: MessageRole,
    content: string,
    meta: MessageMeta = {},
  ): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation: Conversation = id
      ? (this.records.get(id) as Conversation)
      : {
          id: `c-${this.records.size + 1}`,
          title: '新对话',
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
    conversation.messages.push({
      // seq 与真实存储一致：自增序号，滚动摘要的截断点按它比较
      seq: conversation.messages.length + 1,
      id: `m-${conversation.messages.length + 1}`,
      role,
      content,
      // 仅在有值时落该字段，与真实存储「空值写 null」的行为一致
      ...(meta.tools?.length ? { tools: meta.tools } : {}),
      ...(meta.attachments?.length ? { attachments: meta.attachments } : {}),
      ...(meta.sources?.length ? { sources: meta.sources } : {}),
      createdAt: now,
    });
    // 首条用户消息即会话标题，与真实存储的 buildTitle 行为保持一致
    if (conversation.title === '新对话' && role === 'user') conversation.title = content;
    conversation.updatedAt = now;
    this.records.set(conversation.id, conversation);
    return conversation;
  }

  async remove(_userId: number, id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  /** 滚动摘要落库记录：供用例断言摘要内容与截断点推进到了哪一条 */
  readonly summaries: { id: string; summary: string; uptoSeq: number }[] = [];

  async saveSummary(
    _userId: number,
    id: string,
    summary: string,
    uptoSeq: number,
  ): Promise<boolean> {
    const conversation = this.records.get(id);
    // 与真实存储的条件更新同义：截断点只增不减，旧摘要无法覆盖更靠后的截断点
    if (!conversation || (conversation.summaryUptoSeq ?? 0) >= uptoSeq) return false;
    conversation.summary = summary;
    conversation.summaryUptoSeq = uptoSeq;
    this.summaries.push({ id, summary, uptoSeq });
    return true;
  }
}

/** 路由层的假响应：继承 EventEmitter 以接收 streamChatReply 注册的 close 监听 */
class FakeHttpResponse extends EventEmitter {
  readonly events: ChatStreamEvent[] = [];
  readonly locals: { userId: number; log: Logger };
  statusCode = 200;
  body: unknown;
  writableEnded = false;

  constructor() {
    super();
    this.locals = {
      userId: USER_ID,
      log: createLogger({ name: 'chat-route-test', level: 'error', stdio: false }),
    };
  }

  setHeader(): this {
    return this;
  }

  flushHeaders(): void {
    // 无真实 socket，SSE 头部仅需存在该方法
  }

  /** 收集 SSE 帧，供用例断言前端会收到哪些事件 */
  write(chunk: string): boolean {
    const payload = chunk.replace(/^data: /, '').trim();
    if (payload) this.events.push(JSON.parse(payload) as ChatStreamEvent);
    return true;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.body = payload;
    return this;
  }

  end(): void {
    this.writableEnded = true;
  }
}

/** 写不下去的假响应：模拟 socket 缓冲已满，write 恒返回 false 且永不触发 drain */
class SlowHttpResponse extends FakeHttpResponse {
  write(): boolean {
    return false;
  }
}

/** 记录响应头的假响应：用于断言过载响应确实附上了 Retry-After */
class HeaderRecordingResponse extends FakeHttpResponse {
  readonly received: Record<string, string> = {};

  setHeader(name?: string, value?: string): this {
    if (name && value) this.received[name] = value;
    return this;
  }
}

/**
 * 按脚本产出流事件的假智能体；传入 Error 时模拟对话模型服务未启动。
 * onOptions 用于观察透传给智能体的调用参数（如附件 ID）。
 */
function fakeAgent(
  script: AgentStreamEvent[] | Error,
  onOptions?: (options: { fileIds: string[] }) => void,
): AgentService {
  return {
    async *stream(_history: unknown, options: { fileIds: string[] }) {
      onOptions?.(options);
      if (script instanceof Error) throw script;
      for (const event of script) yield event;
    },
  } as unknown as AgentService;
}

/** 内存版文件存储：只维护“当前用户名下有哪些文件”，用于验证附件归属校验 */
class FakeFiles {
  constructor(private readonly owned: string[] = []) {}

  async list(_userId: number, ids: string[]): Promise<StoredFile[]> {
    return ids
      .filter((id) => this.owned.includes(id))
      .map((id) => ({
        id,
        name: `${id}.docx`,
        ext: 'docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 1024,
        createdAt: '2026-09-27T00:00:00.000Z',
      }));
  }
}

/**
 * 路由层只读 config.llm.context 与 config.concurrency，
 * 其余配置与本组用例无关，用断言占位即可。
 */
const CONFIG = {
  llm: { context: { windowTokens: 8192, triggerRatio: 0.7, keepRatio: 0.4, toolRatio: 0.3 } },
  concurrency: {
    chat: { maxInFlight: 8, softLimit: 6, queueLimit: 32, queueTimeoutMs: 20000 },
    upload: { maxInFlight: 2, softLimit: 1, queueLimit: 8, queueTimeoutMs: 10000 },
    crud: { maxInFlight: 32, softLimit: 24, queueLimit: 64, queueTimeoutMs: 5000 },
    chatMaxDurationMs: 180000,
    sseDrainTimeoutMs: 30000,
    shutdownGraceMs: 15000,
  },
} as unknown as AppConfig;

/** 会话锁替身：默认顺序执行任务（无并发的常态）；验证占用与超时时由用例注入专用替身 */
const passthroughLock = {
  run: <T>(_conversationId: string, task: () => Promise<T>): Promise<T> => task(),
};

/** 假依赖集合：会话存储、文件存储与智能体均为替身，用于隔离数据库与模型服务 */
function fakeDeps(
  conversations: FakeConversations,
  agent: AgentService,
  files: FakeFiles = new FakeFiles(),
): Parameters<typeof handleChatMessage>[0] {
  return {
    agent,
    conversations: conversations as unknown as ConversationStore,
    files: files as unknown as FileStore,
    config: CONFIG,
    chatLock: passthroughLock,
  };
}

function fakeRequest(body: {
  message: string;
  conversationId?: string;
  fileIds?: unknown;
}): Request {
  return { body } as unknown as Request;
}

describe('handleChatMessage', () => {
  it('模型服务未启动时不留空会话记录', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();

    await handleChatMessage(
      fakeDeps(conversations, fakeAgent(new Error('无法连接对话模型服务'))),
      fakeRequest({ message: '你好' }),
      res as unknown as Response,
    );

    // 前端只收到 error：没有 done 事件，也就不会刷新出那条没有回复的记录
    expect(res.events.map((event) => event.type)).toEqual(['error']);
    await expect(conversations.list()).resolves.toEqual([]);
  });

  it('生成中途被中断时同样删除新建会话', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();
    // 生成途中客户端断开：首次取值时触发 close 让中断信号生效，再抛错结束本轮
    const agent = {
      stream(): AsyncIterable<AgentStreamEvent> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<AgentStreamEvent>> {
                res.emit('close');
                return Promise.reject(new Error('生成被中断'));
              },
            };
          },
        };
      },
    } as unknown as AgentService;

    await handleChatMessage(
      fakeDeps(conversations, agent),
      fakeRequest({ message: '你好' }),
      res as unknown as Response,
    );

    // 中断不回推错误事件，会话与提问一并清理
    expect(res.events).toEqual([]);
    await expect(conversations.list()).resolves.toEqual([]);
  });

  it('中断前已有产出时保留会话，并留下提问与部分回复', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();
    // 先推一段正文（用户已看到内容），再模拟客户端断开并中断本轮
    const agent = {
      stream(): AsyncIterable<AgentStreamEvent> {
        return {
          [Symbol.asyncIterator]() {
            let step = 0;
            return {
              next(): Promise<IteratorResult<AgentStreamEvent>> {
                step += 1;
                if (step === 1) {
                  return Promise.resolve({
                    done: false,
                    value: { type: 'token', content: '正在' },
                  });
                }
                res.emit('close');
                return Promise.reject(new Error('生成被中断'));
              },
            };
          },
        };
      },
    } as unknown as AgentService;

    await handleChatMessage(
      fakeDeps(conversations, agent),
      fakeRequest({ message: '你好' }),
      res as unknown as Response,
    );

    const [summary] = await conversations.list();
    const saved = await conversations.get(USER_ID, summary.id);
    // 首个产出时就补推会话 ID，客户端因此在中断后仍能接着这条会话发消息
    expect(res.events).toEqual([
      { type: 'conversation', conversationId: summary.id },
      { type: 'token', content: '正在' },
    ]);
    // 用户主动停止只是不再继续生成：已看到的正文与刚发出的提问都要留在历史里
    expect(saved?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(saved?.messages.at(-1)?.content).toBe('正在');
  });

  it('回复为空但请求正常结束时保留会话', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();

    // 模型没有产出任何内容但也没报错：已推送 done，前端已记住该会话 ID，
    // 此时删除会让下一次续发变成「会话不存在」
    await handleChatMessage(
      fakeDeps(conversations, fakeAgent([])),
      fakeRequest({ message: '在吗' }),
      res as unknown as Response,
    );

    expect(res.events.map((event) => event.type)).toEqual(['done']);
    const summaries = await conversations.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].messageCount).toBe(1);
  });

  it('首轮成功时保留会话与提问和回复两条消息', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();

    await handleChatMessage(
      fakeDeps(conversations, fakeAgent([{ type: 'token', content: '你好，在的' }])),
      fakeRequest({ message: '在吗' }),
      res as unknown as Response,
    );

    const [summary] = await conversations.list();
    expect(summary.messageCount).toBe(2);
    expect(res.events.at(-1)).toEqual({
      type: 'done',
      conversationId: summary.id,
      title: '在吗',
    });
  });

  it('检索来源既推给客户端，也随回复落库以便历史回看', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();

    await handleChatMessage(
      fakeDeps(
        conversations,
        fakeAgent([
          { type: 'tool', name: 'search_knowledge_base', status: 'end' },
          { type: 'source', name: '公共手册' },
          { type: 'token', content: '据知识库，苹果是……' },
        ]),
      ),
      fakeRequest({ message: '苹果是什么？' }),
      res as unknown as Response,
    );

    // 来源事件原样转发给客户端，界面上据此渲染来源标签
    expect(res.events).toContainEqual({ type: 'source', name: '公共手册' });
    const [summary] = await conversations.list();
    const saved = await conversations.get(USER_ID, summary.id);
    expect(saved?.messages.at(-1)?.sources).toEqual(['公共手册']);
  });

  it('推理链事件原样推给客户端，但不落库：历史只留正文，推理不进上下文预算', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();

    await handleChatMessage(
      fakeDeps(
        conversations,
        fakeAgent([
          { type: 'thinking', content: '先判断用户问的是定义还是用法。' },
          { type: 'token', content: '人工智能是……' },
          { type: 'thinking', content: '再补一句注意点。' },
        ]),
      ),
      fakeRequest({ message: '什么是人工智能' }),
      res as unknown as Response,
    );

    // 推理链原样转发，界面据此渲染可折叠的「思考过程」面板
    expect(res.events).toContainEqual({
      type: 'thinking',
      content: '先判断用户问的是定义还是用法。',
    });
    const [summary] = await conversations.list();
    const saved = await conversations.get(USER_ID, summary.id);
    // 落库的助手消息只含正文：推理链不落库、不进历史，也就不会计入下一轮的窗口预算
    expect(saved?.messages.at(-1)?.content).toBe('人工智能是……');
  });

  it('既有会话续发失败时保留原有记录', async () => {
    const conversations = new FakeConversations();
    // 先造一轮完整对话，模拟用户已有历史记录
    const { id } = await conversations.append(USER_ID, undefined, 'user', '先前的提问');
    await conversations.append(USER_ID, id, 'assistant', '先前的回复');
    const res = new FakeHttpResponse();

    await handleChatMessage(
      fakeDeps(conversations, fakeAgent(new Error('连接被拒绝'))),
      fakeRequest({ message: '再问一句', conversationId: id }),
      res as unknown as Response,
    );

    const saved = await conversations.get(USER_ID, id);
    expect(saved?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('附件不属于当前用户时返回 404，且不进入流式响应', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();

    await handleChatMessage(
      fakeDeps(conversations, fakeAgent([]), new FakeFiles(['f-1'])),
      fakeRequest({ message: '看看这个文件', fileIds: ['f-2'] }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    expect(res.events).toEqual([]);
    await expect(conversations.list()).resolves.toEqual([]);
  });

  it('附件 ID 去重后透传给智能体，限定工具可读范围', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();
    let received: string[] = [];
    const agent = fakeAgent([], (options) => {
      received = options.fileIds;
    });

    await handleChatMessage(
      fakeDeps(conversations, agent, new FakeFiles(['f-1'])),
      fakeRequest({ message: '看看这个文件', fileIds: ['f-1', 'f-1'] }),
      res as unknown as Response,
    );

    expect(received).toEqual(['f-1']);
  });

  it('历史超出窗口时生成滚动摘要，落库并把摘要注入本轮消息', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();
    // 捕获「本轮对话完成」埋点：核对日志里的取舍指标与下发的 context 事件、摘要落库三处一致
    const records: { message: string; fields?: Record<string, unknown> }[] = [];
    const push = (message: string, fields?: Record<string, unknown>) => {
      records.push({ message, fields });
    };
    const log = {
      // 业务层用 logger.child 派生请求级子日志，这里让它照旧往同一份记录里写
      child: () => ({ debug: push, info: push, warn: () => undefined, error: () => undefined }),
      debug: push,
      info: push,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as Logger;
    res.locals.log = log;
    // 先造一轮超窗口的历史：非 ASCII 每字符 1 token，两轮合计 800 已超过触发阈值 700
    const { id } = await conversations.append(USER_ID, undefined, 'user', '中'.repeat(400));
    await conversations.append(USER_ID, id, 'assistant', '中'.repeat(400));

    const summary = '用户此前问过苹果的价格。';
    let injected: unknown[] = [];
    const agent = {
      summarize: async () => summary,
      async *stream(messages: unknown[]) {
        injected = messages;
        yield { type: 'token', content: '好的' };
      },
    } as unknown as AgentService;

    await handleChatMessage(
      {
        ...fakeDeps(conversations, agent),
        // 窗口取 1000：触发阈值 700、保留预算 400，只装得下最新一轮提问
        config: {
          llm: {
            context: { windowTokens: 1000, triggerRatio: 0.7, keepRatio: 0.4, toolRatio: 0.3 },
          },
          concurrency: CONFIG.concurrency,
        } as unknown as AppConfig,
      },
      fakeRequest({ message: '再问', conversationId: id }),
      res as unknown as Response,
    );

    // 被挤出的前两轮独立成段交给模型压缩，截断点推进到该段末条（seq 2）
    expect(conversations.summaries).toEqual([{ id, summary, uptoSeq: 2 }]);
    // 摘要拼成一条 SystemMessage 插在历史之前：模型据此知道更早的对话，而不是只看到最新一轮
    expect(injected[0]).toBeInstanceOf(SystemMessage);
    expect(String((injected[0] as SystemMessage).content)).toContain(summary);
    expect(injected).toHaveLength(2);
    // 裁剪痕迹推给客户端：提示这轮回答只看到最新一轮，被挤出的两条已压成摘要
    expect(res.events).toContainEqual({ type: 'context', trimmedMessages: 2, summarized: true });
    // 埋点与事件同源：完成日志里的取舍指标须与 context 事件、摘要落库三处对得上，
    // 否则事后按日志复盘会与实际推给前端的判读不一致
    expect(records.find((record) => record.message === '本轮对话完成')?.fields).toMatchObject({
      trimmedMessages: 2,
      summarized: true,
    });
  });

  it('历史未超窗口时不下发 context 事件，避免每轮都挂一条无意义提示', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();

    await handleChatMessage(
      fakeDeps(conversations, fakeAgent([{ type: 'token', content: '好的' }])),
      fakeRequest({ message: '在吗' }),
      res as unknown as Response,
    );

    // 只有 conversation / token / done：没裁历史就不该有治理提示
    expect(res.events.map((event) => event.type)).toEqual(['conversation', 'token', 'done']);
  });

  it('同一会话的上一轮仍在途时，等待超时按可重试过载返回 503', async () => {
    const conversations = new FakeConversations();
    const { id } = await conversations.append(USER_ID, undefined, 'user', '先到的一轮');
    const res = new HeaderRecordingResponse();
    // 会话锁替身直接抛「忙」，等价于排队等待超过上限——真实的排队行为由会话锁单测覆盖
    const busyLock = {
      run: async () => {
        throw new ConversationBusyError(id);
      },
    };

    await handleChatMessage(
      { ...fakeDeps(conversations, fakeAgent([])), chatLock: busyLock },
      fakeRequest({ message: '再问一句', conversationId: id }),
      res as unknown as Response,
    );

    // 过载是「可重试的临时态」：除 503 外必须给出退避建议
    expect(res.statusCode).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(res.body).toEqual({ message: '服务繁忙，请稍后再试' });
    expect(res.received['Retry-After']).toBe('20');
  });

  it('单轮超时中断后已产出的正文仍落库，并回推 error', async () => {
    const conversations = new FakeConversations();
    const res = new FakeHttpResponse();
    // 单轮最长时长压到 20ms：模拟模型推出一段后迟迟不再产出
    const config = {
      ...CONFIG,
      concurrency: { ...CONFIG.concurrency, chatMaxDurationMs: 20 },
    } as unknown as AppConfig;
    const agent = {
      async *stream(_messages: unknown, options: { signal: AbortSignal }) {
        yield { type: 'token' as const, content: '已经开始了' };
        // 悬停到本轮被中断为止，再抛错走「超时中断」收尾路径
        await new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('本轮已中断');
      },
    } as unknown as AgentService;

    await handleChatMessage(
      { ...fakeDeps(conversations, agent), config },
      fakeRequest({ message: '在吗' }),
      res as unknown as Response,
    );

    // 用户已经看到的正文必须留库，否则重开会话时那段回复会凭空消失
    const [summary] = await conversations.list();
    const saved = await conversations.get(USER_ID, summary.id);
    expect(saved?.messages.at(-1)?.content).toBe('已经开始了');
    // 超时是被动中断，客户端需要知道本轮被截断
    expect(res.events).toContainEqual({ type: 'error', message: '本轮对话超时，已中断' });
  });

  it('慢客户端写不下去时中断本轮，不在内存里无限堆积', async () => {
    const conversations = new FakeConversations();
    const res = new SlowHttpResponse();
    // 背压等待上限压到 10ms：write 恒失败且永不 drain，等价于客户端不再读取
    const config = {
      ...CONFIG,
      concurrency: { ...CONFIG.concurrency, sseDrainTimeoutMs: 10 },
    } as unknown as AppConfig;
    let aborted = false;
    const agent = {
      async *stream(_messages: unknown, options: { signal: AbortSignal }) {
        yield { type: 'token' as const, content: '一' };
        // 推下一个事件前，背压超时已把本轮中断
        aborted = options.signal.aborted;
      },
    } as unknown as AgentService;

    await handleChatMessage(
      { ...fakeDeps(conversations, agent), config },
      fakeRequest({ message: '在吗' }),
      res as unknown as Response,
    );

    expect(aborted).toBe(true);
    // 本轮在有限时间内收尾，不会因为客户端不读而永久挂住
    expect(res.writableEnded).toBe(true);
  });
});
