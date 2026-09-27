import path from 'node:path';
import { randomUUID } from 'node:crypto';
// 类型类必须直接从 apache-arrow 取：LanceDB 的 CJS 入口透传导出无法被 ESM 静态识别
import { Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from 'apache-arrow';
import { connect } from '@lancedb/lancedb';
import type { Connection, Table } from '@lancedb/lancedb';
import type { Embeddings } from '@langchain/core/embeddings';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { describeConnectionError } from '../configuration/errors.js';

/** 文档可见范围：global 全局共享，private 仅上传者本人可见 */
export type KnowledgeScope = 'global' | 'private';

export interface KnowledgeDocument {
  id: string;
  title: string;
  scope: KnowledgeScope;
  /** 私有文档的归属用户；全局文档为 null */
  ownerUserId: number | null;
  chunks: number;
  createdAt: string;
}

export interface KnowledgeSearchResult {
  title: string;
  content: string;
  score: number;
}

/** 写入目标：scope 决定归属，全局文档只能由管理入口写入 */
export interface KnowledgeUpload {
  title: string;
  content: string;
  scope: KnowledgeScope;
  userId: number;
}

/** 操作者身份：私有文档仅归属者可删除，全局文档仅管理员可删除 */
export interface KnowledgeActor {
  userId: number;
  isAdmin: boolean;
}

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

const DOCUMENTS_TABLE = 'documents';
const CHUNKS_TABLE = 'chunks';

/** 文档 ID 为 UUID，按白名单校验后再拼进过滤表达式，避免注入 */
const DOCUMENT_ID = /^[0-9a-fA-F-]{36}$/;

/**
 * 文档表结构：显式声明列类型，避免按首行数据推断类型出错
 * （owner_user_id 需要可空，数值列统一用 Float64 以免读出 BigInt）
 */
function documentsSchema(): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('title', new Utf8(), false),
    new Field('scope', new Utf8(), false),
    new Field('owner_user_id', new Float64(), true),
    new Field('chunks', new Float64(), false),
    new Field('embedding_model', new Utf8(), false),
    new Field('dim', new Float64(), false),
    new Field('created_at', new Utf8(), false),
  ]);
}

/** 片段表结构：向量维度在建表时固定，维度不符时写入会直接失败 */
function chunksSchema(dim: number): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('document_id', new Utf8(), false),
    new Field('title', new Utf8(), false),
    new Field('content', new Utf8(), false),
    new Field('scope', new Utf8(), false),
    new Field('owner_user_id', new Float64(), true),
    new Field('created_at', new Utf8(), false),
    new Field('vector', new FixedSizeList(dim, new Field('item', new Float32(), false)), false),
  ]);
}

/** 可见性过滤：全局文档对所有人生效，私有文档只对归属者生效 */
function visibilityFilter(userId: number): string {
  if (!Number.isInteger(userId)) throw new Error('用户 ID 非法');
  return `(scope = 'global' OR owner_user_id = ${userId})`;
}

function readOwner(row: Record<string, unknown>): number | null {
  return row.owner_user_id === null || row.owner_user_id === undefined
    ? null
    : Number(row.owner_user_id);
}

function toDocument(row: Record<string, unknown>): KnowledgeDocument {
  return {
    id: String(row.id),
    title: String(row.title),
    scope: row.scope === 'global' ? 'global' : 'private',
    ownerUserId: readOwner(row),
    chunks: Number(row.chunks),
    createdAt: String(row.created_at),
  };
}

/**
 * 知识库（LanceDB）：文档切分向量化后落在本地库目录中，
 * 检索走向量近邻 + 可见性过滤，实现全局共享与用户私有两级隔离
 */
export class KnowledgeStore {
  private readonly dir: string;
  private connection?: Promise<Connection>;
  /** 向量基准：首次入库后确定，用于发现维度或模型变化 */
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

  private async openTable(name: string): Promise<Table | null> {
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

  /** 读取库内已登记的向量基准；空库时以当前配置作为基准 */
  private async readBaseline(): Promise<{ dim: number; model: string }> {
    if (this.baseline) return this.baseline;
    const table = await this.openTable(DOCUMENTS_TABLE);
    const rows = table ? await table.query().limit(1).toArray() : [];
    const row = rows[0];
    this.baseline = row
      ? { dim: Number(row.dim), model: String(row.embedding_model) }
      : { dim: 0, model: this.options.embeddingModel };
    return this.baseline;
  }

  /**
   * 校验向量维度与模型：换模型后新旧向量不具备可比性，
   * 必须显式报错，否则会按前若干维截断算出错误相似度
   */
  private async assertCompatible(dim: number): Promise<void> {
    const baseline = await this.readBaseline();
    if (baseline.model !== this.options.embeddingModel) {
      throw new Error(
        `知识库由 ${baseline.model} 建立，当前向量模型为 ${this.options.embeddingModel}，请清空知识库后重新导入`,
      );
    }
    if (baseline.dim !== 0 && baseline.dim !== dim) {
      throw new Error(`向量维度不一致：知识库为 ${baseline.dim} 维，当前为 ${dim} 维`);
    }
  }

  /** 调用向量化服务：连接类异常在此翻译成可定位的提示，供入库与检索共用 */
  private async embed<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      throw describeConnectionError(error, this.options.embeddingEndpoint, '向量化服务');
    }
  }

  /** 列出对当前用户可见的文档：全局共享的 + 自己上传的 */
  async list(userId: number): Promise<KnowledgeDocument[]> {
    const table = await this.openTable(DOCUMENTS_TABLE);
    if (!table) return [];
    const rows = await table.query().where(visibilityFilter(userId)).toArray();
    return rows.map(toDocument).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 写入文档：切分 → 批量向量化 → 分别写入文档表与片段表 */
  async add(input: KnowledgeUpload): Promise<KnowledgeDocument> {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: this.options.chunkSize,
      chunkOverlap: this.options.chunkOverlap,
    });
    const pieces = await splitter.splitText(input.content);
    if (pieces.length === 0) throw new Error('文档内容为空，无法切分');

    const vectors = await this.embed(() => this.embeddings.embedDocuments(pieces));
    const dim = vectors[0]?.length ?? 0;
    if (dim === 0) throw new Error('文档向量化结果为空');
    await this.assertCompatible(dim);

    const document: KnowledgeDocument = {
      id: randomUUID(),
      title: input.title,
      scope: input.scope,
      ownerUserId: input.scope === 'global' ? null : input.userId,
      chunks: pieces.length,
      createdAt: new Date().toISOString(),
    };

    const documents = await this.ensureTable(DOCUMENTS_TABLE, documentsSchema());
    await documents.add([
      {
        id: document.id,
        title: document.title,
        scope: document.scope,
        owner_user_id: document.ownerUserId,
        chunks: document.chunks,
        embedding_model: this.options.embeddingModel,
        dim,
        created_at: document.createdAt,
      },
    ]);

    const chunks = await this.ensureTable(CHUNKS_TABLE, chunksSchema(dim));
    await chunks.add(
      pieces.map((content, index) => ({
        id: randomUUID(),
        document_id: document.id,
        title: document.title,
        content,
        scope: document.scope,
        owner_user_id: document.ownerUserId,
        created_at: document.createdAt,
        vector: vectors[index] ?? [],
      })),
    );

    this.baseline = { dim, model: this.options.embeddingModel };
    return document;
  }

  /** 删除文档及其片段：校验归属，权限不足按“不存在”处理，不泄漏他文档信息 */
  async remove(id: string, actor: KnowledgeActor): Promise<boolean> {
    if (!DOCUMENT_ID.test(id)) return false;
    const documents = await this.openTable(DOCUMENTS_TABLE);
    if (!documents) return false;

    const [row] = await documents.query().where(`id = '${id}'`).limit(1).toArray();
    if (!row) return false;
    const owner = readOwner(row);
    const allowed = owner === null ? actor.isAdmin : owner === actor.userId;
    if (!allowed) return false;

    await documents.delete(`id = '${id}'`);
    const chunks = await this.openTable(CHUNKS_TABLE);
    await chunks?.delete(`document_id = '${id}'`);
    return true;
  }

  /** 检索：先按可见性过滤，再按余弦距离取前 topK 条 */
  async search(
    query: string,
    options: { userId: number; topK?: number },
  ): Promise<KnowledgeSearchResult[]> {
    const table = await this.openTable(CHUNKS_TABLE);
    if (!table || (await table.countRows()) === 0) return [];

    const vector = await this.embed(() => this.embeddings.embedQuery(query));
    await this.assertCompatible(vector.length);

    const rows = await table
      .query()
      .nearestTo(vector)
      .distanceType('cosine')
      .where(visibilityFilter(options.userId))
      .limit(options.topK ?? this.options.topK)
      .toArray();

    // 低于相似度下限的片段属于噪声，直接丢弃；过滤后条数可能少于 topK
    return rows
      .map((row) => ({
        title: String(row.title),
        content: String(row.content),
        score: 1 - Number(row._distance),
      }))
      .filter((item) => item.score >= this.options.minScore);
  }

  /** 关闭连接并释放文件句柄，供停机与测试清理使用 */
  async close(): Promise<void> {
    const connection = await this.connection;
    connection?.close();
    this.connection = undefined;
  }
}
