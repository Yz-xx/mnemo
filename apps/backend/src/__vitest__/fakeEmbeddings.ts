import fs from 'node:fs';
import path from 'node:path';
import { Embeddings } from '@langchain/core/embeddings';

// 部分环境对系统临时目录的文件删除受限，统一使用项目内的临时目录
export const TEST_ROOT = path.resolve(process.cwd(), '.tmp');
fs.mkdirSync(TEST_ROOT, { recursive: true });

/** 用关键词命中构造确定性向量，使测试不依赖真实 embedding 服务 */
export class FakeEmbeddings extends Embeddings {
  constructor(private readonly dim = 3) {
    super({});
  }

  private vectorOf(text: string): number[] {
    const hits = ['苹果', '香蕉', '橘子'].map((keyword) => (text.includes(keyword) ? 1 : 0));
    const padding = Array.from({ length: Math.max(0, this.dim - hits.length) }, () => 0);
    return [...hits, ...padding].slice(0, this.dim);
  }

  override async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorOf(text));
  }

  override async embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.vectorOf(text));
  }
}

/** 模拟向量化服务未启动：调用直接失败，用于校验错误提示是否给出可定位的地址 */
export class OfflineEmbeddings extends Embeddings {
  constructor() {
    super({});
  }

  override async embedDocuments(): Promise<number[][]> {
    throw new Error('fetch failed');
  }

  override async embedQuery(): Promise<number[]> {
    throw new Error('fetch failed');
  }
}
