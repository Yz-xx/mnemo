import fs from 'node:fs';
import path from 'node:path';
import { Embeddings } from '@langchain/core/embeddings';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeStore } from './store.js';

// 部分环境对系统临时目录的文件删除受限，统一使用项目内的临时目录
const TEST_ROOT = path.resolve(process.cwd(), '.tmp');
fs.mkdirSync(TEST_ROOT, { recursive: true });

/** 用关键词命中构造确定性向量，使测试不依赖真实 embedding 服务 */
class FakeEmbeddings extends Embeddings {
  constructor() {
    super({});
  }

  private vectorOf(text: string): number[] {
    return ['苹果', '香蕉', '橘子'].map((keyword) => (text.includes(keyword) ? 1 : 0));
  }

  override async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorOf(text));
  }

  override async embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.vectorOf(text));
  }
}

let dataDir: string;
let store: KnowledgeStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(TEST_ROOT, 'knowledge-'));
  store = new KnowledgeStore(dataDir, new FakeEmbeddings(), {
    chunkSize: 60,
    chunkOverlap: 0,
    topK: 2,
  });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('KnowledgeStore', () => {
  it('空白知识库检索结果为空', async () => {
    await expect(store.search('苹果')).resolves.toEqual([]);
  });

  it('文档入库后按片段计数并可按内容检索', async () => {
    const document = await store.add({ title: '水果手册', content: '苹果是一种常见水果。' });

    expect(document.chunks).toBeGreaterThan(0);
    expect(store.list()).toEqual([document]);

    const [top] = await store.search('苹果');
    expect(top.title).toBe('水果手册');
    expect(top.content).toContain('苹果');
  });

  it('删除文档会同时清除其向量片段', async () => {
    const document = await store.add({ title: '水果手册', content: '香蕉是一种常见水果。' });

    expect(store.remove(document.id)).toBe(true);
    expect(store.list()).toEqual([]);
    await expect(store.search('香蕉')).resolves.toEqual([]);
  });
});
