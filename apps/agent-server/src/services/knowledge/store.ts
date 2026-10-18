import type { EmbeddingContext } from './embedding.js';
import type { RetrievalGovernance } from './retrieval.js';
import type {
  KnowledgeActor,
  KnowledgeContent,
  KnowledgeDocument,
  KnowledgeSearchResult,
  KnowledgeUpload,
} from '../../entities/knowledge.js';
import type {
  KnowledgeStoreOptions,
  KnowledgeVectorStore,
} from '../../mappers/knowledge/vectorStore.js';
import type { Embeddings } from '@langchain/core/embeddings';
import { randomUUID } from 'node:crypto';
import {
  readOwner,
  readUpdatedAt,
  toChunkRow,
  toDocument,
  toDocumentRow,
} from '../../mappers/knowledge/documents.js';
import { splitAndEmbed } from './embedding.js';
import { retrieveChunks } from './retrieval.js';

/** 文档 ID 为 UUID：作为存储过滤条件前按白名单校验，避免注入 */
const DOCUMENT_ID = /^[0-9a-fA-F-]{36}$/;

/**
 * 知识库：文档切分向量化后落库，检索走向量近邻 + 可见性过滤，
 * 实现全局共享与用户私有两级隔离。
 * 向量存储适配器由组合根装配（生产注入 PostgreSQL + pgvector 适配器，单测注入内存替身）：
 * 连接、建表、行读写、近邻查询、向量基准校验都收在适配器内；
 * 切分与向量化落在 embedding.ts，检索的闸门 / 超时 / 降级与熔断落在 retrieval.ts，
 * 这里只保留文档业务语义。
 */
export class KnowledgeStore {
  constructor(
    private readonly embeddings: Embeddings,
    private readonly options: KnowledgeStoreOptions,
    /** 向量存储适配器：接受依赖而非自建，单测据此注入替身 */
    private readonly store: KnowledgeVectorStore,
    /** 检索与向量化治理：不传即不治理（本地脚本与单测），生产由组合根注入 */
    private readonly governance?: RetrievalGovernance,
  ) {}

  /** 切分与向量化的上下文：三个只读依赖收成一份，写入路径两处共用 */
  private get embeddingContext(): EmbeddingContext {
    return {
      embeddings: this.embeddings,
      store: this.store,
      options: this.options,
      governance: this.governance,
    };
  }

  /**
   * 按 id 取文档行：不存在一律按不存在处理（返回 null），不泄漏他人文档是否存在。
   * 访问口径分两档：visible 按可见性（全局共享 + 自己上传的，与列表、检索一致），
   * manage 按维护权（管理员或归属者——全局文档不归属个人，因此仅管理员可改可删）
   */
  private async findDocument(
    id: string,
    actor: KnowledgeActor,
    access: 'visible' | 'manage',
  ): Promise<Record<string, unknown> | null> {
    if (!DOCUMENT_ID.test(id)) return null;
    const row = await this.store.findDocument(id);
    if (!row) return null;
    const owner = readOwner(row);
    const allowed =
      access === 'visible'
        ? row.scope === 'global' || owner === actor.userId || actor.isAdmin
        : actor.isAdmin || owner === actor.userId;
    return allowed ? row : null;
  }

  /** 列出对当前用户可见的文档：全局共享的 + 自己上传的 */
  async list(userId: number): Promise<KnowledgeDocument[]> {
    const rows = await this.store.listDocuments(userId);
    return rows.map(toDocument).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 管理端列表：不做可见性过滤，返回全部文档（含各用户的私有文档）。
   * 后台看的是整体归置情况，“谁的文档”由归属字段表达，因此不能套用可见性过滤。
   */
  async listAll(): Promise<KnowledgeDocument[]> {
    const rows = await this.store.listAllDocuments();
    return rows.map(toDocument).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 文档总数（含全局与全部私有文档）：总览看整体规模，不做可见性过滤 */
  async count(): Promise<number> {
    return this.store.countDocuments();
  }

  /** 写入文档：切分 → 批量向量化 → 分别写入文档表与片段表 */
  async add(input: KnowledgeUpload): Promise<KnowledgeDocument> {
    const { pieces, vectors, dim } = await splitAndEmbed(this.embeddingContext, input.content);

    const document: KnowledgeDocument = {
      id: randomUUID(),
      title: input.title,
      scope: input.scope,
      ownerUserId: input.scope === 'global' ? null : input.userId,
      chunks: pieces.length,
      createdAt: new Date().toISOString(),
    };

    await this.store.ensureDocumentStore();
    await this.store.addDocument(
      toDocumentRow(document, input.content, null, dim, this.options.embeddingModel),
    );

    await this.store.ensureChunkStore(dim);
    await this.store.addChunks(
      pieces.map((content, index) =>
        toChunkRow(document, content, vectors[index] ?? [], document.createdAt),
      ),
    );
    return document;
  }

  /** 删除文档及其片段：管理员可删任意文档，普通用户仅限自己上传的；权限不足一律按「不存在」处理 */
  async remove(id: string, actor: KnowledgeActor): Promise<boolean> {
    if (!(await this.findDocument(id, actor, 'manage'))) return false;
    await this.store.removeDocument(id);
    return true;
  }

  /**
   * 读取文档内容：库内存有原文直接返回；旧文档无原文时按分片顺序拼接近似还原
   * （分片有重叠、段落被切开，仅作浏览参考，保存一次编辑即留存正式原文）
   */
  async getContent(id: string, actor: KnowledgeActor): Promise<KnowledgeContent | null> {
    const row = await this.findDocument(id, actor, 'visible');
    if (!row) return null;
    const document = toDocument(row);
    const updatedAt = readUpdatedAt(row);
    const content = String(row.content ?? '');
    if (content) return { document, content, source: 'raw', updatedAt };
    return {
      document,
      content: await this.store.stitchChunks(id),
      source: 'stitched',
      updatedAt,
    };
  }

  /**
   * 编辑文档：整体替换内容并重切分重向量化，id、归属与范围保持不变。
   * 不做逐分片编辑：分片是检索单元，单改文本会与向量不一致，
   * 且重叠区跨分片重复，就地改必然错乱。文档行由存储适配器原位重建
   * （update 的 values 走 SQL 表达式，把用户文本拼进去会注入，禁止）
   */
  async replace(
    id: string,
    input: { title: string; content: string },
    actor: KnowledgeActor,
  ): Promise<KnowledgeDocument | null> {
    const row = await this.findDocument(id, actor, 'manage');
    if (!row) return null;

    const { pieces, vectors, dim } = await splitAndEmbed(this.embeddingContext, input.content);
    const document: KnowledgeDocument = {
      ...toDocument(row),
      title: input.title,
      chunks: pieces.length,
    };
    const updatedAt = new Date().toISOString();

    await this.store.ensureChunkStore(dim);
    await this.store.ensureDocumentStore();
    await this.store.replaceDocument(
      id,
      toDocumentRow(document, input.content, updatedAt, dim, this.options.embeddingModel),
      pieces.map((content, index) =>
        toChunkRow(document, content, vectors[index] ?? [], updatedAt),
      ),
    );
    return document;
  }

  /**
   * 检索：先按可见性过滤，再按余弦距离取前 topK 条。
   * 读路径的闸门、超时与降级都在 services/knowledge/retrieval.ts 内完成，失败即返回空数组
   */
  async search(
    query: string,
    options: { userId: number; topK?: number },
  ): Promise<KnowledgeSearchResult[]> {
    return retrieveChunks({
      store: this.store,
      embeddings: this.embeddings,
      options: this.options,
      governance: this.governance,
      query,
      userId: options.userId,
      topK: options.topK,
    });
  }

  /** 关闭连接并释放文件句柄，供停机与测试清理使用 */
  async close(): Promise<void> {
    await this.store.close();
  }
}
