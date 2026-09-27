import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { createLogger } from '@repo/logger';
import { HTTP_STATUS } from '@repo/reusable';
import type { AgentStreamEvent, ChatStreamEvent } from '@repo/reusable';
import { handleChatMessage } from '../routes/chat.js';
import type { Logger } from '@repo/logger';
import type {
  Conversation,
  ConversationSummary,
  MessageMeta,
  MessageRole,
} from '../conversation/types.js';
import type { ConversationStore } from '../conversation/store.js';
import type { FileStore, StoredFile } from '../files/store.js';
import type { AgentService } from '../llm/agent.js';

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
});
