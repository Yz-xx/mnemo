import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from '../llm/agent.js';
import type { AppConfig } from '../config.js';
import type { FileStore, StoredFile } from '../files/store.js';
import type { VisionReader } from '../llm/vision.js';
import type { KnowledgeStore } from '../rag/store.js';
import type { StoredMessage } from '../conversation/types.js';
import type { AgentStreamEvent } from '@repo/reusable';

/**
 * 捕获 createAgent 收到的对话消息：把真实 agent 换成只记录入参的替身，
 * 从而在不启动对话模型服务的前提下断言「本轮附件内容是否被预读进对话」。
 */
const captured = vi.hoisted(() => ({ rounds: [] as { messages: BaseMessage[] }[] }));

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>();
  return {
    ...actual,
    // 保留 tool 等真实导出，只替换 createAgent：创建工具时仍走真实实现
    createAgent: () => ({
      async stream(input: { messages: BaseMessage[] }) {
        captured.rounds.push(input);
        // 返回空的可迭代对象：本组用例只关心注入到对话里的消息
        return [];
      },
    }),
  };
});

/** 最小可用配置：仅需满足 AgentService 构造时读取的字段 */
const CONFIG: AppConfig = {
  port: 3000,
  dataDir: 'tmp',
  log: { level: 'error', dir: 'tmp', retentionDays: 1 },
  mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'agent_data' },
  llm: { provider: 'ollama', temperature: 0.3 },
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
): Promise<BaseMessage[]> {
  const service = new AgentService(
    CONFIG,
    {} as unknown as KnowledgeStore,
    files as unknown as FileStore,
    vision,
  );
  const history: StoredMessage[] = [
    { id: 'm-1', role: 'user', content: '这张图里是什么？', createdAt: '2026-09-27T00:00:00.000Z' },
  ];

  const events: AgentStreamEvent[] = [];
  for await (const event of service.stream(history, { userId: 1, fileIds })) events.push(event);

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
});
