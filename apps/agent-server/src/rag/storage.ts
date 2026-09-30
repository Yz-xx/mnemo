import type { Connection, Table } from '@lancedb/lancedb';
import type { Embeddings } from '@langchain/core/embeddings';
import type { Schema } from 'apache-arrow';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';
import { describeConnectionError } from '../configuration/errors.js';
import { DOCUMENTS_APPENDED_COLUMNS, DOCUMENTS_TABLE } from './lance.js';

export interface KnowledgeStoreOptions {
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  /** 相似度下限：低于该分数的片段视为噪声丢弃 */
  minScore: number;
  /** 当前向量模型名称，用于识别换模型导致的向量不可比 */
  embeddingModel: string;
  /** 向量化服务地址，用于把连接失败翻译成可定位的提示 */
  embeddingEndpoint: string;
}

/**
 * 知识库底层存储：LanceDB 连接、建表与旧表补列、向量化调用、向量基准校验。
 * 这些机制与文档业务语义无关，独立成模块便于单独演进与排查，
 * KnowledgeStore 在其上组合出增删改查与检索。
 */
export class KnowledgeStorage {
  private readonly dir: string;
  private connection?: Promise<Connection>;
  /** 向量基准：首次校验后缓存，用于发现维度或模型变化 */
  private baseline?: { dim: number; model: string };

  constructor(
    dataDir: string,
    private readonly embeddings: Embeddings,
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
  async openExisting(name: string): Promise<Table | null> {
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

  /** 建表并保证结构最新（写入路径用） */
  async ensure(name: string, schema: Schema): Promise<Table> {
    const table = await this.ensureTable(name, schema);
    if (name === DOCUMENTS_TABLE) await this.migrateAppendedColumns(table);
    return table;
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

  /** 读取库内已登记的向量基准；空库时以当前配置作为基准 */
  private async readBaseline(): Promise<{ dim: number; model: string }> {
    if (this.baseline) return this.baseline;
    const table = await this.openExisting(DOCUMENTS_TABLE);
    const rows = table ? await table.query().limit(1).toArray() : [];
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

  /** 调用向量化服务：连接类异常在此翻译成可定位的提示，供入库与检索共用 */
  private async embed<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      throw describeConnectionError(error, this.options.embeddingEndpoint, '向量化服务');
    }
  }

  /** 批量向量化片段：写入路径（入库与编辑）用 */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(() => this.embeddings.embedDocuments(texts));
  }

  /** 向量化单个查询：检索路径用 */
  async embedQuery(text: string): Promise<number[]> {
    return this.embed(() => this.embeddings.embedQuery(text));
  }

  /** 关闭连接并释放文件句柄，供停机与测试清理使用 */
  async close(): Promise<void> {
    const connection = await this.connection;
    connection?.close();
    this.connection = undefined;
  }
}
