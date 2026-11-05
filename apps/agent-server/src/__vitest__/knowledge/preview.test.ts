import type { KnowledgeDocument } from '../../entities/knowledge.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KNOWLEDGE_FILE_SUBDIR } from '../../services/knowledge/ingest.js';
import { readDocumentPreview } from '../../services/knowledge/preview.js';

/** 测试用操作者：预览只复用可见性结果，这里固定为自己的私有文档 */
const ACTOR = { userId: 1, isAdmin: false };

/** 构造测试文档：文件类文档才落盘，粘贴文本无原始文件名 */
function makeDocument(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 'doc-1',
    title: '公共手册',
    knowledgeBaseId: 'kb-1',
    chunks: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    fileName: '公共手册.txt',
    fileSize: 10,
    mimeType: 'text/plain',
    status: 'ready',
    failureReason: null,
    ...overrides,
  };
}

/** 只实现预览用到的 getContent：content 为 null 模拟文档已被删除 */
function fakeKnowledge(content: string | null) {
  return {
    async getContent() {
      if (content === null) return null;
      return { document: makeDocument(), content, source: 'raw' as const, updatedAt: null };
    },
  };
}

let uploadDir: string;

beforeEach(async () => {
  uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemo-preview-'));
});

afterEach(async () => {
  await fs.rm(uploadDir, { recursive: true, force: true });
});

describe('readDocumentPreview', () => {
  it('文本类返回解析后全文，不依赖原始文件仍在磁盘上', async () => {
    const preview = await readDocumentPreview(
      { knowledge: fakeKnowledge('苹果是水果。'), uploadDir },
      makeDocument(),
      ACTOR,
    );

    expect(preview).toMatchObject({ kind: 'text', content: '苹果是水果。' });
  });

  it('粘贴文本没有原始文件名时同样返回库内全文', async () => {
    const preview = await readDocumentPreview(
      { knowledge: fakeKnowledge('手工录入的内容'), uploadDir },
      makeDocument({ fileName: null, fileSize: null, mimeType: null }),
      ACTOR,
    );

    expect(preview).toMatchObject({ kind: 'text', content: '手工录入的内容' });
  });

  it('文本类在文档已被删除时不返回内容，按缺失处理', async () => {
    const preview = await readDocumentPreview(
      { knowledge: fakeKnowledge(null), uploadDir },
      makeDocument(),
      ACTOR,
    );

    expect(preview).toEqual({ kind: 'missing' });
  });

  it('二进制类返回流式起点，不读取全文', async () => {
    const document = makeDocument({ fileName: '手册.pdf', mimeType: 'application/pdf' });
    const target = path.join(uploadDir, KNOWLEDGE_FILE_SUBDIR, document.id);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '%PDF-1.4');

    const preview = await readDocumentPreview(
      { knowledge: fakeKnowledge('不应被调用'), uploadDir },
      document,
      ACTOR,
    );

    expect(preview).toMatchObject({
      kind: 'file',
      filePath: target,
      fileName: '手册.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('二进制类原始文件缺失时按缺失处理，不抛底层错误', async () => {
    const preview = await readDocumentPreview(
      { knowledge: fakeKnowledge(null), uploadDir },
      makeDocument({ fileName: '手册.pdf', mimeType: 'application/pdf' }),
      ACTOR,
    );

    expect(preview).toEqual({ kind: 'missing' });
  });
});
