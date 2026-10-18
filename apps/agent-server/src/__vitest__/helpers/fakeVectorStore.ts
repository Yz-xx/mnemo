import type {
  KnowledgeStoreOptions,
  KnowledgeVectorStore,
  StoredChunkHit,
} from '../../mappers/knowledge/vectorStore.js';

/** 余弦相似度：两边任一为零向量时按无相似度（0）处理 */
function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * 内存版向量存储替身：以 Map / 数组存文档与片段，用余弦相似度做近邻检索并套同样的可见性过滤。
 * 供 KnowledgeStore 业务语义用例隔离 PostgreSQL——只实现适配器契约，不模拟 SQL，
 * 因此编排层用例不会退化成对 SQL 片段的脆弱匹配（适配器自身的 SQL 由 pgStore.test.ts 覆盖）。
 */
export class FakeVectorStore implements KnowledgeVectorStore {
  private readonly documents = new Map<string, Record<string, unknown>>();
  private readonly chunks: Record<string, unknown>[] = [];
  /** 向量基准：与真实适配器同口径，用于校验换模型 / 换维度 */
  private baseline?: { dim: number; model: string };

  constructor(private readonly options: KnowledgeStoreOptions) {}

  async ensureDocumentStore(): Promise<void> {}

  async ensureChunkStore(_dim: number): Promise<void> {}

  async addDocument(row: Record<string, unknown>): Promise<void> {
    this.documents.set(String(row.id), { ...row });
  }

  async addChunks(rows: Record<string, unknown>[]): Promise<void> {
    this.chunks.push(...rows.map((row) => ({ ...row })));
  }

  async replaceDocument(
    id: string,
    document: Record<string, unknown>,
    chunks: Record<string, unknown>[],
  ): Promise<void> {
    this.documents.delete(id);
    this.removeChunksOf(id);
    await this.addDocument(document);
    await this.addChunks(chunks);
  }

  async removeDocument(id: string): Promise<void> {
    this.documents.delete(id);
    this.removeChunksOf(id);
  }

  /** 按文档清理片段：倒序删避免下标位移 */
  private removeChunksOf(id: string): void {
    for (let index = this.chunks.length - 1; index >= 0; index -= 1) {
      if (this.chunks[index].document_id === id) this.chunks.splice(index, 1);
    }
  }

  async findDocument(id: string): Promise<Record<string, unknown> | null> {
    return this.documents.get(id) ?? null;
  }

  async listDocuments(userId: number): Promise<Record<string, unknown>[]> {
    return [...this.documents.values()].filter(
      (row) => row.scope === 'global' || row.owner_user_id === userId,
    );
  }

  async listAllDocuments(): Promise<Record<string, unknown>[]> {
    return [...this.documents.values()];
  }

  async countDocuments(): Promise<number> {
    return this.documents.size;
  }

  async countChunks(): Promise<number> {
    return this.chunks.length;
  }

  /** 按写入次序拼正文：与真实适配器一样靠 chunk_index 隐含有序 */
  async stitchChunks(documentId: string): Promise<string> {
    return this.chunks
      .filter((chunk) => chunk.document_id === documentId)
      .map((chunk) => String(chunk.content))
      .join('\n\n');
  }

  /** 近邻检索：可见性预过滤 → 余弦相似度降序 → 取前 topK，分数不做阈值过滤 */
  async searchChunks(
    vector: number[],
    options: { userId: number; topK: number },
  ): Promise<StoredChunkHit[]> {
    return this.chunks
      .filter((chunk) => chunk.scope === 'global' || chunk.owner_user_id === options.userId)
      .map((chunk) => ({ chunk, score: cosine(vector, chunk.vector as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK)
      .map(({ chunk, score }) => ({
        documentId: String(chunk.document_id),
        title: String(chunk.title),
        content: String(chunk.content),
        score,
      }));
  }

  /** 读取库内已登记的向量基准；空库时以当前配置作为基准 */
  private readBaseline(): { dim: number; model: string } {
    if (this.baseline) return this.baseline;
    const row = [...this.documents.values()][0];
    this.baseline = row
      ? { dim: Number(row.dim), model: String(row.embedding_model) }
      : { dim: 0, model: this.options.embeddingModel };
    return this.baseline;
  }

  async assertCompatible(dim: number): Promise<void> {
    const baseline = this.readBaseline();
    if (baseline.model !== this.options.embeddingModel) {
      throw new Error(
        `知识库由 ${baseline.model} 建立，当前向量模型为 ${this.options.embeddingModel}，请清空知识库后重新导入`,
      );
    }
    if (baseline.dim !== 0 && baseline.dim !== dim) {
      throw new Error(`向量维度不一致：知识库为 ${baseline.dim} 维，当前为 ${dim} 维`);
    }
    this.baseline = { dim, model: this.options.embeddingModel };
  }

  /** 内存替身无连接可放：留给 KnowledgeStore.close() 的调用点一个空实现 */
  async close(): Promise<void> {}
}
