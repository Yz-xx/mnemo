import type { AppDependencies } from '../../configuration/dependencies.js';
import type {
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeFileUpload,
} from '../../entities/knowledge.js';
import type { Server } from 'node:http';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HTTP_STATUS } from '@mnemo/reusable';
import { createKnowledgeRouter } from '../../controllers/client/knowledge.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { knowledgeFilePath } from '../../services/knowledge/index.js';
import { TEST_ROOT } from '../helpers/fakeEmbeddings.js';

/** let 服务器地址与上传目录在每个用例后重置 */
let uploadDir: string;
let server: Server | null = null;
let origin = '';

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(TEST_ROOT, 'kb-route-'));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

/** 造一条库记录 */
function makeBase(
  id: string,
  visibility: 'global' | 'private',
  ownerUserId: number | null,
): KnowledgeBase {
  return {
    id,
    name: `库 ${id}`,
    description: null,
    visibility,
    ownerUserId,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  };
}

/** 内存版文档存储：实现上传、重试与预览会调用到的方法 */
class FakeKnowledge {
  readonly added: KnowledgeDocument[] = [];
  readonly failures: { id: string; reason: string }[] = [];
  readonly documents: KnowledgeDocument[] = [];
  /** 预览可见性：未登记的文档一律按「他人私有文档」返回 null */
  readonly visible = new Set<string>();
  /** 文本预览内容：按文档 ID 存放解析后全文 */
  readonly contents = new Map<string, string>();

  async addPending(input: KnowledgeFileUpload): Promise<KnowledgeDocument> {
    const document: KnowledgeDocument = {
      ...input,
      chunks: 0,
      createdAt: '2026-11-05T00:00:00.000Z',
      status: 'processing',
      failureReason: null,
    };
    this.added.push(document);
    this.documents.push(document);
    return document;
  }

  async markFailed(id: string, reason: string): Promise<void> {
    this.failures.push({ id, reason });
  }

  async findManageable(id: string): Promise<KnowledgeDocument | null> {
    return this.documents.find((document) => document.id === id) ?? null;
  }

  async findVisible(id: string): Promise<KnowledgeDocument | null> {
    if (!this.visible.has(id)) return null;
    return this.documents.find((document) => document.id === id) ?? null;
  }

  async getContent(id: string): Promise<{ content: string } | null> {
    const content = this.contents.get(id);
    return content === undefined ? null : { content };
  }

  async markProcessing(id: string): Promise<boolean> {
    const document = this.documents.find((item) => item.id === id);
    if (!document) return false;
    document.status = 'processing';
    document.failureReason = null;
    return true;
  }
}

/** 组装被测路由：只注入该模块用到的依赖 */
function createDeps(options: {
  bases: KnowledgeBase[];
  knowledge: FakeKnowledge;
  enqueued: KnowledgeDocument[];
  maxBytes?: number;
}): AppDependencies {
  return {
    config: {
      upload: { dir: uploadDir, maxBytes: options.maxBytes ?? 1024 * 1024, maxFiles: 1 },
      knowledge: { adminToken: '' },
    },
    knowledge: options.knowledge,
    knowledgeBases: {
      find: async (id: string) => options.bases.find((base) => base.id === id) ?? null,
    },
    knowledgeIngest: {
      enqueue: (document: KnowledgeDocument) => options.enqueued.push(document),
      discard: async (): Promise<void> => undefined,
    },
  } as unknown as AppDependencies;
}

/** 挂载路由并监听随机端口，返回可访问的 origin */
async function startApp(deps: AppDependencies): Promise<string> {
  const app = express();
  app.use(express.json());
  // 鉴权与请求日志中间件在正式应用里写入 locals，这里按同一约定直接注入
  app.use((_req, res, next) => {
    res.locals.userId = 7;
    res.locals.log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    next();
  });
  app.use('/api/knowledge', createKnowledgeRouter(deps));
  app.use(errorHandler);
  server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('测试服务未取得端口');
  return `http://127.0.0.1:${address.port}`;
}

/** 构造 multipart 请求体：文件名与内容都由用例指定 */
function makeForm(fileName: string, content: Buffer): FormData {
  const form = new FormData();
  form.append('file', new Blob([content]), fileName);
  return form;
}

/** 上传目录下的 .tmp 残留数：用于验证临时文件已被清理 */
function tempFileCount(): number {
  const dir = path.join(uploadDir, '.tmp');
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
}

describe('POST /api/knowledge/bases/:id/documents/file', () => {
  it('合法 TXT 上传成功：返回 processing 记录、落盘并触发入队', async () => {
    const knowledge = new FakeKnowledge();
    const enqueued: KnowledgeDocument[] = [];
    origin = await startApp(
      createDeps({ bases: [makeBase('kb-1', 'private', 7)], knowledge, enqueued }),
    );

    const response = await fetch(`${origin}/api/knowledge/bases/kb-1/documents/file`, {
      method: 'POST',
      body: makeForm('说明.txt', Buffer.from('知识库正文')),
    });

    expect(response.status).toBe(HTTP_STATUS.CREATED);
    const body = (await response.json()) as KnowledgeDocument;
    expect(body).toMatchObject({ fileName: '说明.txt', status: 'processing', title: '说明.txt' });
    // 正式文件按文档 ID 落盘，原名只入库展示
    const stored = knowledgeFilePath(uploadDir, body.id);
    expect(fs.readFileSync(stored, 'utf8')).toBe('知识库正文');
    expect(enqueued.map((document) => document.id)).toEqual([body.id]);
    expect(tempFileCount()).toBe(0);
  });

  it('扩展名与内容不一致时返回 400，且不建记录、不留临时文件', async () => {
    const knowledge = new FakeKnowledge();
    const enqueued: KnowledgeDocument[] = [];
    origin = await startApp(
      createDeps({ bases: [makeBase('kb-1', 'private', 7)], knowledge, enqueued }),
    );

    const response = await fetch(`${origin}/api/knowledge/bases/kb-1/documents/file`, {
      method: 'POST',
      body: makeForm('伪装.txt', Buffer.from('%PDF-1.7\n1 0 obj\n')),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(knowledge.added).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(tempFileCount()).toBe(0);
  });

  it('类型不在白名单时返回 400', async () => {
    const knowledge = new FakeKnowledge();
    const enqueued: KnowledgeDocument[] = [];
    origin = await startApp(
      createDeps({ bases: [makeBase('kb-1', 'private', 7)], knowledge, enqueued }),
    );

    const response = await fetch(`${origin}/api/knowledge/bases/kb-1/documents/file`, {
      method: 'POST',
      body: makeForm('图片.png', Buffer.from('纯文本内容')),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(knowledge.added).toEqual([]);
  });

  it('库不存在或不可维护时返回 404，并清掉已落下的临时文件', async () => {
    const knowledge = new FakeKnowledge();
    const enqueued: KnowledgeDocument[] = [];
    // 全局库对客户端只读，上传按不可维护处理
    origin = await startApp(
      createDeps({ bases: [makeBase('kb-1', 'global', null)], knowledge, enqueued }),
    );

    const response = await fetch(`${origin}/api/knowledge/bases/kb-1/documents/file`, {
      method: 'POST',
      body: makeForm('说明.txt', Buffer.from('知识库正文')),
    });

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(knowledge.added).toEqual([]);
    expect(tempFileCount()).toBe(0);
  });

  it('超过单文件大小上限时返回 400', async () => {
    const knowledge = new FakeKnowledge();
    const enqueued: KnowledgeDocument[] = [];
    origin = await startApp(
      createDeps({ bases: [makeBase('kb-1', 'private', 7)], knowledge, enqueued, maxBytes: 8 }),
    );

    const response = await fetch(`${origin}/api/knowledge/bases/kb-1/documents/file`, {
      method: 'POST',
      body: makeForm('说明.txt', Buffer.from('超过八个字节的内容')),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(knowledge.added).toEqual([]);
  });
});

describe('POST /api/knowledge/documents/:id/retry', () => {
  it('仅 failed 文档可重试：processing 文档返回 400', async () => {
    const knowledge = new FakeKnowledge();
    await knowledge.addPending({
      id: 'doc-1',
      title: '说明',
      knowledgeBaseId: 'kb-1',
      fileName: '说明.txt',
      fileSize: 10,
      mimeType: 'text/plain',
    });
    const enqueued: KnowledgeDocument[] = [];
    origin = await startApp(
      createDeps({ bases: [makeBase('kb-1', 'private', 7)], knowledge, enqueued }),
    );

    const response = await fetch(`${origin}/api/knowledge/documents/doc-1/retry`, {
      method: 'POST',
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(enqueued).toEqual([]);
  });

  it('failed 文档重试：重置 processing、清空失败原因并重新入队', async () => {
    const knowledge = new FakeKnowledge();
    await knowledge.addPending({
      id: 'doc-2',
      title: '说明',
      knowledgeBaseId: 'kb-1',
      fileName: '说明.txt',
      fileSize: 10,
      mimeType: 'text/plain',
    });
    knowledge.documents[0].status = 'failed';
    knowledge.documents[0].failureReason = '解析服务不可用';
    const enqueued: KnowledgeDocument[] = [];
    origin = await startApp(
      createDeps({ bases: [makeBase('kb-1', 'private', 7)], knowledge, enqueued }),
    );

    const response = await fetch(`${origin}/api/knowledge/documents/doc-2/retry`, {
      method: 'POST',
    });

    expect(response.status).toBe(HTTP_STATUS.OK);
    const body = (await response.json()) as KnowledgeDocument;
    expect(body).toMatchObject({ id: 'doc-2', status: 'processing', failureReason: null });
    expect(enqueued).toHaveLength(1);
  });

  it('文档不存在时返回 404', async () => {
    const knowledge = new FakeKnowledge();
    const enqueued: KnowledgeDocument[] = [];
    origin = await startApp(
      createDeps({ bases: [makeBase('kb-1', 'private', 7)], knowledge, enqueued }),
    );

    const response = await fetch(`${origin}/api/knowledge/documents/missing/retry`, {
      method: 'POST',
    });

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

/** 造一条文档记录：预览只用到 id、文件名 / MIME 与所属库 */
function makeDocument(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 'doc-1',
    title: '说明',
    knowledgeBaseId: 'kb-1',
    chunks: 1,
    createdAt: '2026-11-05T00:00:00.000Z',
    fileName: '说明.txt',
    fileSize: 10,
    mimeType: 'text/plain',
    status: 'ready',
    failureReason: null,
    ...overrides,
  };
}

describe('GET /api/knowledge/documents/:id/preview', () => {
  it('文本文档返回解析后全文', async () => {
    const knowledge = new FakeKnowledge();
    const document = makeDocument();
    knowledge.documents.push(document);
    knowledge.visible.add(document.id);
    knowledge.contents.set(document.id, '苹果是水果。');
    origin = await startApp(createDeps({ bases: [], knowledge, enqueued: [] }));

    const response = await fetch(`${origin}/api/knowledge/documents/doc-1/preview`);

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await response.json()).toMatchObject({ kind: 'text', content: '苹果是水果。' });
  });

  it('他人私有文档按不存在处理，返回 404', async () => {
    const knowledge = new FakeKnowledge();
    const document = makeDocument({ fileName: null, fileSize: null, mimeType: null });
    knowledge.documents.push(document);
    // 不登记 visible：模拟文档属于他人私有库，不可见即不该暴露它的存在
    origin = await startApp(createDeps({ bases: [], knowledge, enqueued: [] }));

    const response = await fetch(`${origin}/api/knowledge/documents/doc-1/preview`);

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it('二进制文档原始文件缺失时返回 404', async () => {
    const knowledge = new FakeKnowledge();
    const document = makeDocument({ fileName: '手册.pdf', mimeType: 'application/pdf' });
    knowledge.documents.push(document);
    knowledge.visible.add(document.id);
    origin = await startApp(createDeps({ bases: [], knowledge, enqueued: [] }));

    const response = await fetch(`${origin}/api/knowledge/documents/doc-1/preview`);

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it('二进制文档存在时按内联方式流式返回原始文件', async () => {
    const knowledge = new FakeKnowledge();
    const document = makeDocument({ fileName: '手册.pdf', mimeType: 'application/pdf' });
    knowledge.documents.push(document);
    knowledge.visible.add(document.id);
    const target = knowledgeFilePath(uploadDir, document.id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '%PDF-1.4 test');
    origin = await startApp(createDeps({ bases: [], knowledge, enqueued: [] }));

    const response = await fetch(`${origin}/api/knowledge/documents/doc-1/preview`);

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    // 文件名走 RFC 5987 编码：中文原名不进响应头的裸 ASCII 段
    expect(response.headers.get('content-disposition')).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent('手册.pdf')}`,
    );
    expect(await response.text()).toBe('%PDF-1.4 test');
  });
});
