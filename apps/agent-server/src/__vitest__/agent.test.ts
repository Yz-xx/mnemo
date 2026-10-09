import type { AppConfig } from '../configuration/config/index.js';
import type { FileStore, StoredFile } from '../files/store/index.js';
import type { VisionReader } from '../llm/vision.js';
import type { KnowledgeStore } from '../rag/index.js';
import type { BaseMessage, ToolCallChunk } from '@langchain/core/messages';
import type { AgentStreamEvent } from '@repo/reusable';
import { AIMessageChunk, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from '../llm/agent.js';

/**
 * 捕获 createAgent 收到的对话消息：把真实 agent 换成只记录入参的替身，
 * 从而在不启动对话模型服务的前提下断言「本轮附件内容是否被预读进对话」。
 * `chunks` 供工具事件用例注入要吐出的流分片，默认空数组即不产任何事件。
 */
const captured = vi.hoisted(() => ({
  rounds: [] as { messages: BaseMessage[] }[],
  chunks: [] as unknown[],
}));

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>();
  return {
    ...actual,
    // 保留 tool 等真实导出，只替换 createAgent：创建工具时仍走真实实现
    createAgent: () => ({
      async stream(input: { messages: BaseMessage[] }) {
        captured.rounds.push(input);
        return captured.chunks;
      },
    }),
  };
});

/** 最小可用配置：仅需满足 AgentService 构造时读取的字段 */
const CONFIG: AppConfig = {
  port: 3000,
  dataDir: 'tmp',
  log: { level: 'error', dir: 'tmp', retentionDays: 1 },
  mysql: {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'agent_data',
    queueLimit: 32,
    connectTimeoutMs: 10000,
  },
  http: {
    headersTimeoutMs: 20000,
    requestTimeoutMs: 120000,
    keepAliveTimeoutMs: 65000,
    maxRequestsPerSocket: 1000,
  },
  concurrency: {
    chat: { maxInFlight: 8, softLimit: 6, queueLimit: 32, queueTimeoutMs: 20000 },
    upload: { maxInFlight: 2, softLimit: 1, queueLimit: 8, queueTimeoutMs: 10000 },
    crud: { maxInFlight: 32, softLimit: 24, queueLimit: 64, queueTimeoutMs: 5000 },
    chatMaxDurationMs: 180000,
    sseDrainTimeoutMs: 30000,
    shutdownGraceMs: 15000,
    model: { maxInFlight: 2, softLimit: 1, queueLimit: 8, queueTimeoutMs: 20000 },
    summary: { maxInFlight: 1, softLimit: 1, queueLimit: 0, queueTimeoutMs: 3000 },
    retrieval: { maxInFlight: 4, softLimit: 2, queueLimit: 8, queueTimeoutMs: 3000 },
    parse: { maxInFlight: 2, softLimit: 1, queueLimit: 8, queueTimeoutMs: 5000 },
    retrievalTimeoutMs: 8000,
    circuitFailureThreshold: 5,
    circuitCooldownMs: 30000,
  },
  apiLog: { batchSize: 50, flushIntervalMs: 1000 },
  auth: { sessionCacheTtlMs: 5000 },
  llm: {
    provider: 'ollama',
    temperature: 0.3,
    thinking: false,
    context: { windowTokens: 8192, triggerRatio: 0.7, keepRatio: 0.4, toolRatio: 0.3 },
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    chatModel: 'test-chat',
    embeddingModel: 'test-embedding',
    // 留空即关闭图片理解，构造视觉读取器时不会真的连模型
    visionModel: '',
  },
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', chatModel: 'deepseek-chat' },
  embedding: { provider: 'ollama', apiKey: '', baseUrl: '', model: '' },
  knowledge: { chunkSize: 60, chunkOverlap: 0, topK: 4, minScore: 0.6, adminToken: '' },
  upload: { dir: 'tmp', maxBytes: 1024, maxFiles: 3, allowedTypes: ['png', 'jpg', 'jpeg'] },
  initialAdmin: { username: 'root', password: 'admin-secret' },
};

/** 假视觉读取器：不连模型，直接回一段可断言的描述，用于验证图片内容真的进了对话 */
const FAKE_VISION: VisionReader = {
  enabled: true,
  describe: async () => '图中是黑色粗线条字符，内容为 7。',
};

/** 内存版文件存储：list 只做清单过滤，read 返回占位字节或按需「取不到」 */
class FakeFiles {
  constructor(
    private readonly records: StoredFile[] = [],
    /** 这些 ID 的字节取不到，用于覆盖「元数据在、文件已失效」的路径 */
    private readonly unreadable: string[] = [],
  ) {}

  async list(_userId: number, ids: string[]): Promise<StoredFile[]> {
    return this.records.filter((file) => ids.includes(file.id));
  }

  async read(_userId: number, id: string): Promise<{ file: StoredFile; bytes: Buffer } | null> {
    const file = this.records.find((item) => item.id === id);
    if (!file || this.unreadable.includes(id)) return null;
    return { file, bytes: Buffer.from('fake-bytes') };
  }
}

function stored(id: string, name: string): StoredFile {
  return {
    id,
    name,
    ext: 'png',
    mime: 'image/png',
    size: 1024,
    createdAt: '2026-09-27T00:00:00.000Z',
  };
}

/** 跑完一轮流式对话，返回替身 agent 记录到的消息数组 */
async function runStream(
  fileIds: string[],
  files: FakeFiles,
  vision: VisionReader = FAKE_VISION,
  /** 覆盖上下文配置：用于把单轮额度压到 0，验证超额度时的表现 */
  context?: Partial<AppConfig['llm']['context']>,
): Promise<BaseMessage[]> {
  const config: AppConfig = context
    ? { ...CONFIG, llm: { ...CONFIG.llm, context: { ...CONFIG.llm.context, ...context } } }
    : CONFIG;
  const service = new AgentService(
    config,
    {} as unknown as KnowledgeStore,
    files as unknown as FileStore,
    vision,
  );
  // 组装已上提到 chatStream 层，这里直接给组装好的消息
  const messages: BaseMessage[] = [new HumanMessage('这张图里是什么？')];

  const events: AgentStreamEvent[] = [];
  for await (const event of service.stream(messages, { userId: 1, fileIds })) events.push(event);

  // 替身 agent 不产出任何流事件，本组用例只关心它收到的入参
  expect(events).toEqual([]);
  return captured.rounds.at(-1)?.messages ?? [];
}

/** 取出注入的附件提示：它是对话里唯一的 SystemMessage */
function findHint(messages: BaseMessage[]): SystemMessage | undefined {
  return messages.find((message): message is SystemMessage => message instanceof SystemMessage);
}

describe('AgentService 附件预读注入', () => {
  beforeEach(() => {
    captured.rounds.length = 0;
  });

  it('本轮有附件时，把预读到的内容注入对话末尾（不只列文件名）', async () => {
    const messages = await runStream(['f-1'], new FakeFiles([stored('f-1', 'cat.png')]));

    // 用户提问仍在，预读结果追加在其后，模型能同时看到「问什么」与「图里有什么」
    expect(messages.some((message) => message instanceof HumanMessage)).toBe(true);
    expect(messages.at(-1)).toBeInstanceOf(SystemMessage);

    const hint = String(findHint(messages)?.content);
    expect(hint).toContain('f-1');
    expect(hint).toContain('cat.png');
    // 关键：注入的是读到的内容本身，模型不必再自行决定是否调用 read_file
    expect(hint).toContain('7');
  });

  it('附件字节取不到时注入读取失败的说明，而不是静默当作没有附件', async () => {
    const files = new FakeFiles([stored('f-1', 'cat.png')], ['f-1']);
    const messages = await runStream(['f-1'], files);

    const hint = String(findHint(messages)?.content);
    expect(hint).toContain('cat.png');
    expect(hint).toContain('读取失败');
  });

  it('本轮没有附件时不注入提示', async () => {
    const messages = await runStream([], new FakeFiles([stored('f-1', 'cat.png')]));

    expect(findHint(messages)).toBeUndefined();
  });

  it('附件 ID 不属于当前用户时不注入提示', async () => {
    const messages = await runStream(['f-9'], new FakeFiles([stored('f-1', 'cat.png')]));

    expect(findHint(messages)).toBeUndefined();
  });

  it('本轮额度耗尽时附件正文不注入，只留文件名与额度说明', async () => {
    // 窗口取 1、toolRatio 0.3：折算出的额度为 0，附件预读被整段挡下
    const messages = await runStream(
      ['f-1'],
      new FakeFiles([stored('f-1', 'cat.png')]),
      FAKE_VISION,
      { windowTokens: 1 },
    );

    const hint = String(findHint(messages)?.content);
    // 抬头行仍在：模型至少知道本轮有这份附件
    expect(hint).toContain('cat.png');
    expect(hint).toContain('预算上限');
    // 视觉模型转述的正文没有进来
    expect(hint).not.toContain('7');
  });
});

/** 构造一条模型输出分片：工具调用的 name 只在首片出现，args 是增量 JSON 字符串 */
function aiChunk(parts: ToolCallChunk[]): unknown {
  return [new AIMessageChunk({ content: '', tool_call_chunks: parts }), {}];
}

/** 构造工具执行结束的消息：Agent 据此推 end，必要时兜底补 start */
function toolDone(name: string): unknown {
  return [new ToolMessage({ content: 'ok', tool_call_id: 'c1', name }), {}];
}

/** 让替身 agent 按给定分片吐流，返回 AgentService 推出的全部事件 */
async function runChunks(chunks: unknown[]): Promise<AgentStreamEvent[]> {
  captured.chunks.push(...chunks);
  const service = new AgentService(
    CONFIG,
    {} as unknown as KnowledgeStore,
    new FakeFiles() as unknown as FileStore,
    FAKE_VISION,
  );

  const events: AgentStreamEvent[] = [];
  for await (const event of service.stream([new HumanMessage('问题')], {
    userId: 1,
    fileIds: [],
  })) {
    events.push(event);
  }
  return events;
}

describe('AgentService 工具事件', () => {
  beforeEach(() => {
    captured.rounds.length = 0;
    captured.chunks.length = 0;
  });

  it('参数分片未拼完时不发开始事件，拼完才带 detail 发一次', async () => {
    const events = await runChunks([
      aiChunk([
        {
          id: 'c1',
          name: 'search_knowledge_base',
          index: 0,
          type: 'tool_call_chunk',
          args: '{"query":"',
        },
      ]),
      aiChunk([{ id: 'c1', index: 0, type: 'tool_call_chunk', args: '人工智能"}' }]),
      // 参数已经在上一片拼完整：这一片不应再推一次开始事件
      aiChunk([{ id: 'c1', index: 0, type: 'tool_call_chunk', args: '' }]),
      toolDone('search_knowledge_base'),
    ]);

    expect(events).toEqual([
      {
        type: 'tool',
        name: 'search_knowledge_base',
        status: 'start',
        detail: '检索知识库：人工智能',
      },
      { type: 'tool', name: 'search_knowledge_base', status: 'end' },
    ]);
  });

  it('参数始终解析不出时，由工具结束兜底补发带标签的开始事件', async () => {
    const events = await runChunks([
      aiChunk([
        { id: 'c2', name: 'read_file', index: 0, type: 'tool_call_chunk', args: '{"fileId":' },
      ]),
      toolDone('read_file'),
    ]);

    expect(events).toEqual([
      { type: 'tool', name: 'read_file', status: 'start', detail: '读取文件' },
      { type: 'tool', name: 'read_file', status: 'end' },
    ]);
  });

  it('同一轮里同名工具的两次调用各自推出一次开始事件', async () => {
    const events = await runChunks([
      aiChunk([
        {
          id: 'c1',
          name: 'search_knowledge_base',
          index: 0,
          type: 'tool_call_chunk',
          args: '{"query":"甲"}',
        },
      ]),
      aiChunk([
        {
          id: 'c2',
          name: 'search_knowledge_base',
          index: 1,
          type: 'tool_call_chunk',
          args: '{"query":"乙"}',
        },
      ]),
    ]);

    expect(events).toEqual([
      { type: 'tool', name: 'search_knowledge_base', status: 'start', detail: '检索知识库：甲' },
      { type: 'tool', name: 'search_knowledge_base', status: 'start', detail: '检索知识库：乙' },
    ]);
  });
});

describe('AgentService 推理链事件', () => {
  beforeEach(() => {
    captured.rounds.length = 0;
    captured.chunks.length = 0;
  });

  it('推理内容在 additional_kwargs 里时下发 thinking 事件（Ollama 开启 think 的实际路径）', async () => {
    const events = await runChunks([
      [
        new AIMessageChunk({
          content: '',
          additional_kwargs: { reasoning_content: '先看用户问的是定义还是用法，' },
        }),
        {},
      ],
      [new AIMessageChunk({ content: '人工智能是……' }), {}],
    ]);

    expect(events).toEqual([
      { type: 'thinking', content: '先看用户问的是定义还是用法，' },
      { type: 'token', content: '人工智能是……' },
    ]);
  });

  it('推理内容在内容块里时同样下发，且同一分片里的正文不会混进推理', async () => {
    const events = await runChunks([
      [
        new AIMessageChunk({
          content: [
            { type: 'reasoning', reasoning: '先把单位换算一下。' },
            { type: 'text', text: '答案是 42。' },
          ],
        }),
        {},
      ],
    ]);

    // 正文只进 token：推理因此不会随正文落库、进历史或计入上下文预算
    expect(events).toEqual([
      { type: 'thinking', content: '先把单位换算一下。' },
      { type: 'token', content: '答案是 42。' },
    ]);
  });

  it('模型不产推理内容时不发 thinking 事件，事件序列与改动前一致', async () => {
    const events = await runChunks([[new AIMessageChunk({ content: '直接作答。' }), {}]]);

    expect(events).toEqual([{ type: 'token', content: '直接作答。' }]);
  });
});
