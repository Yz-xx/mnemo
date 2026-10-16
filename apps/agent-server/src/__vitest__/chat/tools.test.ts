import type { ParseRunner } from '../../files/parseGovernance.js';
import type { FileStore, StoredFile } from '../../files/store/index.js';
import type { GeneratedFileRef } from '../../llm/tools/index.js';
import type { VisionReader } from '../../llm/vision.js';
import type { BaseMessage } from '@langchain/core/messages';
import type { LogSink } from '@repo/logger';
import fs from 'node:fs';
import path from 'node:path';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { createAgent } from 'langchain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@repo/logger';
import { ERROR_MESSAGE } from '../../configuration/messages.js';
import { ParseOverloadedError } from '../../files/parseGovernance.js';
import { createToolBudget } from '../../llm/context/index.js';
import { createTools } from '../../llm/tools/index.js';
import { DISABLED_VISION, VISION_DISABLED_MESSAGE } from '../../llm/vision.js';
import { KnowledgeStore } from '../../rag/index.js';
import { FakeEmbeddings, TEST_ROOT } from '../helpers/fakeEmbeddings.js';
import { PASSTHROUGH_PARSE } from '../helpers/fakeParse.js';

const OPTIONS = {
  chunkSize: 60,
  chunkOverlap: 0,
  topK: 4,
  minScore: 0.6,
  embeddingModel: 'fake-embedding',
  embeddingEndpoint: 'http://127.0.0.1:11434',
};

/** 单测固定走嵌入式 LanceDB：工具用例与本地库绑定，不依赖 PostgreSQL（见 docs/adr/0012 阶段 3） */
const VECTOR = { provider: 'lance' } as const;

let dataDir: string;
let store: KnowledgeStore;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(TEST_ROOT, 'tools-'));
  store = new KnowledgeStore(dataDir, new FakeEmbeddings(), OPTIONS, undefined, VECTOR);
  await store.add({
    title: '公共手册',
    content: '苹果和香蕉都是全局共享资料。',
    scope: 'global',
    userId: 1,
  });
  await store.add({
    title: '我的笔记',
    content: '香蕉是我的私有资料。',
    scope: 'private',
    userId: 1,
  });
});

afterEach(async () => {
  await store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 组装只检索一次的智能体：把工具输出回显为最终回答，便于断言工具拿到的检索结果 */
function buildAgent(files: FakeFiles = new FakeFiles()) {
  const model = fakeModel()
    .respondWithTools([{ name: 'search_knowledge_base', args: { query: '香蕉' } }])
    .respond((messages: BaseMessage[]) => new AIMessage(String(messages.at(-1)?.content ?? '')));

  return createAgent({
    model,
    tools: createTools(
      store,
      files as unknown as Pick<FileStore, 'list' | 'read' | 'save'>,
      DISABLED_VISION,
      PASSTHROUGH_PARSE,
    ),
    systemPrompt: '测试用智能体',
    name: 'agent',
  });
}

describe('search_knowledge_base 工具', () => {
  it('检索结果按调用者身份过滤，不包含他人私有文档', async () => {
    const result = await buildAgent().invoke(
      { messages: [{ role: 'user', content: '香蕉在哪个文档里？' }] },
      { configurable: { userId: 2 } },
    );

    const reply = String(result.messages.at(-1)?.content ?? '');
    expect(reply).toContain('公共手册');
    expect(reply).not.toContain('我的笔记');
  });

  it('命中的文档名登记到来源收集器，供 Agent 推给客户端', async () => {
    const sources: string[] = [];

    await buildAgent().invoke(
      { messages: [{ role: 'user', content: '香蕉在哪个文档里？' }] },
      { configurable: { userId: 1, sources } },
    );

    // 来源由检索工具直接登记，不依赖模型在正文里标注出处
    expect(sources).toContain('公共手册');
  });

  it('检索日志记录命中数与最高分，并带上注入的请求上下文', async () => {
    const lines: string[] = [];
    const sink: LogSink = { color: false, write: (line) => void lines.push(line) };
    const logger = createLogger({
      name: 'test',
      level: 'debug',
      stdio: false,
      sinks: [sink],
    }).child({
      requestId: 'abcd1234',
    });

    await buildAgent().invoke(
      { messages: [{ role: 'user', content: '香蕉在哪个文档里？' }] },
      { configurable: { userId: 1, logger } },
    );

    const searchLine = lines.find((line) => line.includes('检索知识库'));
    expect(searchLine).toBeDefined();
    expect(searchLine).toContain('requestId=abcd1234');
    expect(searchLine).toContain('query=香蕉');
    expect(searchLine).toMatch(/hits=[1-9]\d*/);
    expect(searchLine).toMatch(/topScore=\d/);
  });

  it('同一文档在本轮被再次命中时不重复注入内容', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'search_knowledge_base', args: { query: '香蕉' } }])
      .respondWithTools([{ name: 'search_knowledge_base', args: { query: '香蕉' } }])
      .respond((messages: BaseMessage[]) => new AIMessage(String(messages.at(-1)?.content ?? '')));

    const result = await buildSearchAgent(model).invoke(
      { messages: [{ role: 'user', content: '香蕉在哪个文档里？' }] },
      { configurable: { userId: 1, toolBudget: createToolBudget(1000) } },
    );

    const toolMessages = result.messages.filter((message) => message instanceof ToolMessage);
    // 两次命中同一份文档：第一次回填片段，第二次只说明已经给过，不重复占窗口
    expect(toolMessages).toHaveLength(2);
    expect(String(toolMessages[0].content)).toContain('公共手册');
    expect(String(toolMessages[1].content)).toContain('未重复注入');
  });

  it('本轮额度耗尽时不再注入检索结果，并如实说明', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'search_knowledge_base', args: { query: '香蕉' } }])
      .respond((messages: BaseMessage[]) => new AIMessage(String(messages.at(-1)?.content ?? '')));

    const result = await buildSearchAgent(model).invoke(
      { messages: [{ role: 'user', content: '香蕉在哪个文档里？' }] },
      // 预算 1 个 token：连提示都放不下，检索结果只能整体不注入
      { configurable: { userId: 1, toolBudget: createToolBudget(1) } },
    );

    const toolMessage = result.messages.find((message) => message instanceof ToolMessage);
    expect(String(toolMessage?.content)).toContain('上下文预算上限');
  });
});

/** 组装检索智能体：本组用例不涉及文件能力，附件存储给空替身 */
function buildSearchAgent(model: ReturnType<typeof fakeModel>) {
  return createAgent({
    model,
    tools: createTools(
      store,
      new FakeFiles() as unknown as Pick<FileStore, 'list' | 'read' | 'save'>,
      DISABLED_VISION,
      PASSTHROUGH_PARSE,
    ),
    systemPrompt: '测试用智能体',
    name: 'agent',
  });
}

/** 内存版文件存储：伪造元数据与字节，记录读取过的 ID 与生成的导出，用于验证读的边界与导出的产物 */
class FakeFiles {
  readonly readIds: string[] = [];
  readonly saved: { name: string; ext: string; mime: string; bytes: Buffer }[] = [];

  constructor(private readonly records: Record<string, { file: StoredFile; bytes: Buffer }> = {}) {}

  async list(_userId: number, ids: string[]): Promise<StoredFile[]> {
    return ids.flatMap((id) => (this.records[id] ? [this.records[id].file] : []));
  }

  async read(_userId: number, id: string) {
    this.readIds.push(id);
    return this.records[id] ?? null;
  }

  async save(
    _userId: number,
    upload: { name: string; ext: string; mime: string; bytes: Buffer },
  ): Promise<StoredFile> {
    this.saved.push(upload);
    return {
      id: `f-out-${this.saved.length}`,
      name: upload.name,
      ext: upload.ext,
      mime: upload.mime,
      size: upload.bytes.length,
      createdAt: '2026-09-27T00:00:00.000Z',
    };
  }
}

/** 造一份真实 docx 的存储记录：工具链路要真的走到解析器，伪造的字节证明不了什么 */
async function docxRecord(id: string, name: string, text: string) {
  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun(text)] })] }],
  });
  const bytes = Buffer.from(await Packer.toBuffer(doc));
  return {
    file: {
      id,
      name,
      ext: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: bytes.length,
      createdAt: '2026-09-27T00:00:00.000Z',
    },
    bytes,
  };
}

/**
 * 组装调用指定工具的智能体，并把工具输出回显为最终回答，便于断言工具返回了什么。
 * 视觉能力默认关闭：只有图片理解相关的用例才需要传入替身；
 * 解析走直通闸门：只有验证解析过载降级的用例才需要传入会拒绝的替身。
 */
function buildFileAgent(
  files: FakeFiles,
  call: { name: string; args: Record<string, unknown> },
  vision: VisionReader = DISABLED_VISION,
  parse: ParseRunner = PASSTHROUGH_PARSE,
) {
  const model = fakeModel()
    .respondWithTools([call])
    .respond((messages: BaseMessage[]) => new AIMessage(String(messages.at(-1)?.content ?? '')));

  return createAgent({
    model,
    tools: createTools(
      store,
      files as unknown as Pick<FileStore, 'list' | 'read' | 'save'>,
      vision,
      parse,
    ),
    systemPrompt: '测试用智能体',
    name: 'agent',
  });
}

/** 以指定附件发起一轮对话，返回最终回答文本 */
async function askWithFiles(
  files: FakeFiles,
  call: { name: string; args: Record<string, unknown> },
  fileIds: string[],
  vision: VisionReader = DISABLED_VISION,
): Promise<string> {
  const result = await buildFileAgent(files, call, vision).invoke(
    { messages: [{ role: 'user', content: '看看我传的文件' }] },
    { configurable: { userId: 7, fileIds } },
  );
  return String(result.messages.at(-1)?.content ?? '');
}

describe('文件工具', () => {
  it('list_files 列出本轮附件的 ID 与文件名', async () => {
    const record = await docxRecord('f-1', '季度报告.docx', '营收增长 12%');
    const files = new FakeFiles({ 'f-1': record });

    const reply = await askWithFiles(files, { name: 'list_files', args: {} }, ['f-1']);

    expect(reply).toContain('f-1');
    expect(reply).toContain('季度报告.docx');
  });

  it('本轮没有附件时给出明确提示', async () => {
    const reply = await askWithFiles(new FakeFiles(), { name: 'list_files', args: {} }, []);

    expect(reply).toContain('没有附带文件');
  });

  it('read_file 返回附件解析后的正文', async () => {
    const record = await docxRecord('f-1', '季度报告.docx', '营收增长 12%');
    const files = new FakeFiles({ 'f-1': record });

    const reply = await askWithFiles(files, { name: 'read_file', args: { fileId: 'f-1' } }, [
      'f-1',
    ]);

    expect(reply).toContain('营收增长 12%');
  });

  it('read_file 拒绝读取不属于本轮的附件，且不触碰存储', async () => {
    const record = await docxRecord('f-9', '别人的文件.docx', '不该被读到');
    const files = new FakeFiles({ 'f-9': record });

    const reply = await askWithFiles(files, { name: 'read_file', args: { fileId: 'f-9' } }, [
      'f-1',
    ]);

    expect(reply).toContain('不在本轮对话的附件中');
    expect(files.readIds).toEqual([]);
  });

  it('read_file 读到图片但未配置视觉模型时如实说明', async () => {
    const files = new FakeFiles({
      'f-2': {
        file: {
          id: 'f-2',
          name: '截图.png',
          ext: 'png',
          mime: 'image/png',
          size: 4,
          createdAt: '2026-09-27T00:00:00.000Z',
        },
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    });

    const reply = await askWithFiles(files, { name: 'read_file', args: { fileId: 'f-2' } }, [
      'f-2',
    ]);

    // 对话模型看不到图，未配视觉模型时必须说清楚，不能让模型凭空编造图片内容
    expect(reply).toContain(VISION_DISABLED_MESSAGE);
  });

  it('read_file 读到图片时交给视觉模型转述', async () => {
    const files = new FakeFiles({
      'f-img': {
        file: {
          id: 'f-img',
          name: '销售趋势.png',
          ext: 'png',
          mime: 'image/png',
          size: 9,
          createdAt: '2026-09-27T00:00:00.000Z',
        },
        // PNG 文件头，凑够能说明“原始字节被透传”的长度
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      },
    });
    const seen: { mime: string; bytes: number }[] = [];
    const vision: VisionReader = {
      enabled: true,
      describe: async ({ bytes, mime }) => {
        seen.push({ mime, bytes: bytes.length });
        return '图中是一张销售趋势折线图，1 月到 3 月持续上升';
      },
    };

    const reply = await askWithFiles(
      files,
      { name: 'read_file', args: { fileId: 'f-img' } },
      ['f-img'],
      vision,
    );

    expect(reply).toContain('销售趋势折线图');
    // 交给视觉模型的必须是原始字节与真实 MIME，否则拼出来的 data URI 是坏的
    expect(seen).toEqual([{ mime: 'image/png', bytes: 9 }]);
  });

  it('read_file 受本轮额度限制，额度耗尽时如实说明', async () => {
    const record = await docxRecord('f-1', '季度报告.docx', '营收增长 12%');
    const files = new FakeFiles({ 'f-1': record });

    const result = await buildFileAgent(files, {
      name: 'read_file',
      args: { fileId: 'f-1' },
    }).invoke(
      { messages: [{ role: 'user', content: '看看我传的文件' }] },
      // 预算 1 个 token：连提示都放不下，读取结果只能整体不注入
      { configurable: { userId: 7, fileIds: ['f-1'], toolBudget: createToolBudget(1) } },
    );

    const toolMessage = result.messages.find((message) => message instanceof ToolMessage);
    expect(String(toolMessage?.content)).toContain('上下文预算上限');
  });

  it('解析过载时 read_file 如实回注过载提示，不打断整轮', async () => {
    const record = await docxRecord('f-1', '季度报告.docx', '营收增长 12%');
    const files = new FakeFiles({ 'f-1': record });
    // 解析闸门拒绝：模拟 CPU 密集的解析被小额度挡下
    const overloaded: ParseRunner = { run: () => Promise.reject(new ParseOverloadedError()) };

    const result = await buildFileAgent(
      files,
      { name: 'read_file', args: { fileId: 'f-1' } },
      DISABLED_VISION,
      overloaded,
    ).invoke(
      { messages: [{ role: 'user', content: '看看我传的文件' }] },
      { configurable: { userId: 7, fileIds: ['f-1'] } },
    );

    const toolMessage = result.messages.find((message) => message instanceof ToolMessage);
    // 过载属可重试的临时状态：如实把文案交回模型转达，而不是抛错打断整轮
    expect(String(toolMessage?.content)).toContain(ERROR_MESSAGE.OVERLOADED);
  });

  it('write_file 生成文件并登记到导出收集器，供客户端下载', async () => {
    const files = new FakeFiles();
    const exported: GeneratedFileRef[] = [];

    const result = await buildFileAgent(files, {
      name: 'write_file',
      args: { name: '会议纪要', format: 'docx', content: '第一行\n第二行' },
    }).invoke(
      { messages: [{ role: 'user', content: '整理成文件' }] },
      { configurable: { userId: 7, fileIds: [], exported } },
    );

    expect(String(result.messages.at(-1)?.content ?? '')).toContain('会议纪要.docx');
    expect(files.saved).toHaveLength(1);
    expect(files.saved[0].ext).toBe('docx');
    // 收集器里的引用才是客户端真正拿到的东西：ID 与展示名必须一并在
    expect(exported).toEqual([
      { fileId: 'f-out-1', name: '会议纪要.docx', size: files.saved[0].bytes.length },
    ]);
  });

  it('write_file 剥掉文件名里的扩展名与路径分隔符', async () => {
    const files = new FakeFiles();

    await askWithFiles(
      files,
      { name: 'write_file', args: { name: '../报表.xlsx', format: 'xlsx', content: '姓名|分数' } },
      [],
    );

    expect(files.saved[0].name).toBe('报表.xlsx');
  });
});
