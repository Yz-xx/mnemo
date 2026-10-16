import type { KnowledgeStoreOptions, KnowledgeVectorStore, StoredChunkHit } from './vectorStore.js';
import type { Connection, Table } from '@lancedb/lancedb';
import type { Schema } from 'apache-arrow';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';
import {
  CHUNKS_TABLE,
  chunksSchema,
  DOCUMENTS_APPENDED_COLUMNS,
  DOCUMENTS_TABLE,
  documentsSchema,
  visibilityFilter,
} from './lance.js';

/**
 * 知识库向量存储的 LanceDB 适配器（见 docs/adr/0012 · 阶段 0）。
 * 连接、建表与旧表补列、行读写、近邻检索、向量基准校验都收敛在这里；
 * 阶段 1 换 pgvector 时新增同接口的 PgVectorStore，本文件作为回退路径保留一个迭代周期。
 */
export class LanceVectorStore implements KnowledgeVectorStore {
  private readonly dir: string;
  private connection?: Promise<Connection>;
  /** 向量基准：首次校验后缓存，用于发现维度或模型变化 */
  private baseline?: { dim: number; model: string };

  constructor(
    dataDir: string,
    private readonly options: KnowledgeStoreOptions,
  ) {
    this.dir = path.join(dataDir, 'knowledge', 'lancedb');
  }

  /** 惰性建立连接：目录不存在时由 LanceDB 创建 */
  private db(): Promise<Connection> {
    this.connection ??= connect(this.dir);
    return this.connection;
  }

  /** 打开已存在的表，不存在时返回 null（读取路径用） */
  private async openExisting(name: string): Promise<Table | null> {
    const db = await this.db();
    const names = await db.tableNames();
    return names.includes(name) ? db.openTable(name) : null;
  }

  /** 取表；不存在时按给定结构建空表，已存在则直接复用 */
  private async ensureTable(name: string, schema: Schema): Promise<Table> {
    const db = await this.db();
    const names = await db.tableNames();
    if (names.includes(name)) return db.openTable(name);
    try {
      return await db.createEmptyTable(name, schema);
    } catch {
      // 并发入库时另一次调用可能已完成建表，直接复用
      return db.openTable(name);
    }
  }

  /**
   * 旧表不随 documentsSchema 演进自动加列：缺列时补列（旧行为空值）。
   * valueSql 必须用 SQL 空串字面量而非 'NULL'——NULL 会被推断成 Null 类型列，
   * 之后 add 写入的字符串值全部静默丢失；空串是 utf8 类型，且在所有读取路径
   * （getContent 的原文判定、updated_at 的空值判定）与 null 同效。
   * 对已存在的列 addColumns 会报错，必须先比对 schema 再补，整段幂等可重复执行
   */
  private async migrateAppendedColumns(table: Table): Promise<void> {
    const schema = await table.schema();
    const existing = new Set(schema.fields.map((field) => field.name));
    const missing = DOCUMENTS_APPENDED_COLUMNS.filter((name) => !existing.has(name));
    if (missing.length === 0) return;
    await table.addColumns(missing.map((name) => ({ name, valueSql: "''" })));
  }

  async ensureDocumentStore(): Promise<void> {
    const documents = await this.ensureTable(DOCUMENTS_TABLE, documentsSchema());
    await this.migrateAppendedColumns(documents);
  }

  async ensureChunkStore(dim: number): Promise<void> {
    await this.ensureTable(CHUNKS_TABLE, chunksSchema(dim));
  }

  async addDocument(row: Record<string, unknown>): Promise<void> {
    const documents = await this.openExisting(DOCUMENTS_TABLE);
    await documents?.add([row]);
  }

  async addChunks(rows: Record<string, unknown>[]): Promise<void> {
    const chunks = await this.openExisting(CHUNKS_TABLE);
    await chunks?.add(rows);
  }

  async replaceDocument(
    id: string,
    document: Record<string, unknown>,
    chunks: Record<string, unknown>[],
  ): Promise<void> {
    // 先重建片段再重建文档行：片段行自带归属字段，不依赖文档行先就位
    const chunkTable = await this.openExisting(CHUNKS_TABLE);
    await chunkTable?.delete(`document_id = '${id}'`);
    await chunkTable?.add(chunks);

    const documentTable = await this.openExisting(DOCUMENTS_TABLE);
    await documentTable?.delete(`id = '${id}'`);
    await documentTable?.add([document]);
  }

  async removeDocument(id: string): Promise<void> {
    const documents = await this.openExisting(DOCUMENTS_TABLE);
    await documents?.delete(`id = '${id}'`);
    const chunks = await this.openExisting(CHUNKS_TABLE);
    await chunks?.delete(`document_id = '${id}'`);
  }

  async findDocument(id: string): Promise<Record<string, unknown> | null> {
    const documents = await this.openExisting(DOCUMENTS_TABLE);
    if (!documents) return null;
    const [row] = await documents.query().where(`id = '${id}'`).limit(1).toArray();
    return row ?? null;
  }

  async listDocuments(userId: number): Promise<Record<string, unknown>[]> {
    const documents = await this.openExisting(DOCUMENTS_TABLE);
    if (!documents) return [];
    return documents.query().where(visibilityFilter(userId)).toArray();
  }

  async listAllDocuments(): Promise<Record<string, unknown>[]> {
    const documents = await this.openExisting(DOCUMENTS_TABLE);
    return documents ? documents.query().toArray() : [];
  }

  async countDocuments(): Promise<number> {
    const documents = await this.openExisting(DOCUMENTS_TABLE);
    return documents ? documents.countRows() : 0;
  }

  async countChunks(): Promise<number> {
    const chunks = await this.openExisting(CHUNKS_TABLE);
    return chunks ? chunks.countRows() : 0;
  }

  async stitchChunks(documentId: string): Promise<string> {
    const chunks = await this.openExisting(CHUNKS_TABLE);
    if (!chunks) return '';
    const rows = await chunks.query().where(`document_id = '${documentId}'`).toArray();
    return rows.map((chunk) => String(chunk.content)).join('\n\n');
  }

  async searchChunks(
    vector: number[],
    options: { userId: number; topK: number },
  ): Promise<StoredChunkHit[]> {
    const chunks = await this.openExisting(CHUNKS_TABLE);
    if (!chunks) return [];
    const rows = await chunks
      .query()
      .nearestTo(vector)
      .distanceType('cosine')
      .where(visibilityFilter(options.userId))
      .limit(options.topK)
      .toArray();
    // 把距离还原成相似度；低于下限的过滤留在检索层，与现状一致
    return rows.map((row) => ({
      documentId: String(row.document_id),
      title: String(row.title),
      content: String(row.content),
      score: 1 - Number(row._distance),
    }));
  }

  /** 读取库内已登记的向量基准；空库时以当前配置作为基准 */
  private async readBaseline(): Promise<{ dim: number; model: string }> {
    if (this.baseline) return this.baseline;
    const documents = await this.openExisting(DOCUMENTS_TABLE);
    const rows = documents ? await documents.query().limit(1).toArray() : [];
    const row = rows[0];
    this.baseline = row
      ? { dim: Number(row.dim), model: String(row.embedding_model) }
      : { dim: 0, model: this.options.embeddingModel };
    return this.baseline;
  }

  /**
   * 校验向量维度与模型：换模型后新旧向量不具备可比性，
   * 必须显式报错，否则会按前若干维截断算出错误相似度。
   * 校验通过即把当前配置记为基准缓存，省去后续每次读表
   */
  async assertCompatible(dim: number): Promise<void> {
    const baseline = await this.readBaseline();
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

  /** 关闭连接并释放文件句柄，供停机与测试清理使用 */
  async close(): Promise<void> {
    const connection = await this.connection;
    connection?.close();
    this.connection = undefined;
  }
}
