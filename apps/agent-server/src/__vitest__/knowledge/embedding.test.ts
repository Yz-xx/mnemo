import type { EmbeddingContext } from '../../services/knowledge/embedding.js';
import { describe, expect, it } from 'vitest';
import { splitAndEmbed } from '../../services/knowledge/embedding.js';

/** 构造最小切分上下文：向量与维度兼容校验都用替身，本组只验证页码归并 */
function createContext(chunkSize: number): EmbeddingContext {
  return {
    embeddings: {
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
    },
    store: { assertCompatible: async () => undefined },
    options: { chunkSize, chunkOverlap: 0, embeddingEndpoint: 'http://localhost:11434' },
  } as unknown as EmbeddingContext;
}

describe('splitAndEmbed 页码归并', () => {
  it('长页被切成多段时，每段继承该页页码', async () => {
    const content = `【第 1 页】${'甲'.repeat(40)}【第 2 页】${'乙'.repeat(40)}`;

    const { pieces } = await splitAndEmbed(createContext(20), content);

    expect(pieces.length).toBeGreaterThan(2);
    // 同页切出的后续片段不能因为片段内没有标记就丢掉定位
    expect(pieces.every((piece) => piece.page !== null)).toBe(true);
    expect(pieces.at(-1)?.page).toBe(2);
  });

  it('逐页切分：片段不跨页，页码按页归属', async () => {
    const content = `【第 1 页】${'甲'.repeat(10)}【第 2 页】${'乙'.repeat(10)}`;

    const { pieces } = await splitAndEmbed(createContext(200), content);

    // 标记含空格会被切分器当成分隔符，故先按页拆段再切，两页各自成片段
    expect(pieces.map((piece) => piece.page)).toEqual([1, 2]);
  });

  it('文本来源没有页标记时页码为 null', async () => {
    const { pieces } = await splitAndEmbed(createContext(20), '纯文本内容，没有页码标记');

    expect(pieces.map((piece) => piece.page)).toEqual([null]);
  });
});
