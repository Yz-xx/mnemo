import type {
  KnowledgeActor,
  KnowledgeContent,
  KnowledgeDocument,
  KnowledgeUpload,
} from './documents.js';
import type { KnowledgeSearchResult } from './search.js';
import type { KnowledgeStoreOptions } from './storage.js';
import type { Embeddings } from '@langchain/core/embeddings';
import { randomUUID } from 'node:crypto';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { readOwner, readUpdatedAt, toChunkRow, toDocument, toDocumentRow } from './documents.js';
import {
  CHUNKS_TABLE,
  chunksSchema,
  DOCUMENT_ID,
  DOCUMENTS_TABLE,
  documentsSchema,
} from './lance.js';
import { visibilityFilter } from './search.js';
import { KnowledgeStorage } from './storage.js';

/**
 * 知识库（LanceDB）：文档切分向量化后落在本地库目录中，
 * 检索走向量近邻 + 可见性过滤，实现全局共享与用户私有两级隔离。
 * 连接、建表与旧表补列、向量基准校验由 KnowledgeStorage 承担，这里只保留文档业务语义。
 */
export class KnowledgeStore {
  private readonly storage: KnowledgeStorage;

  constructor(
    dataDir: string,
    embeddings: Embeddings,
    private readonly options: KnowledgeStoreOptions,
  ) {
    this.storage = new KnowledgeStorage(dataDir, embeddings, options);
  }

  /**
   * 切分并批量向量化：空内容与空结果直接抛错，基准校验失败原样抛出。
   * 入库与编辑共用，且始终在动库之前完成——最易失败的步骤前置，
   * 失败时库内数据保持原样，重试即可恢复
   */
  private async embedPieces(
    content: string,
  ): Promise<{ pieces: string[]; vectors: number[][]; dim: number }> {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: this.options.chunkSize,
      chunkOverlap: this.options.chunkOverlap,
    });
    const pieces = await splitter.splitText(content);
    if (pieces.length === 0) throw new Error('文档内容为空，无法切分');

    const vectors = await this.storage.embedDocuments(pieces);
    const dim = vectors[0]?.length ?? 0;
    if (dim === 0) throw new Error('文档向量化结果为空');
    await this.storage.assertCompatible(dim);
    return { pieces, vectors, dim };
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
    const documents = await this.storage.openExisting(DOCUMENTS_TABLE);
    if (!documents) return null;
    const [row] = await documents.query().where(`id = '${id}'`).limit(1).toArray();
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
    const table = await this.storage.openExisting(DOCUMENTS_TABLE);
    if (!table) return [];
    const rows = await table.query().where(visibilityFilter(userId)).toArray();
    return rows.map(toDocument).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 管理端列表：不做可见性过滤，返回全部文档（含各用户的私有文档）。
   * 后台看的是整体归置情况，“谁的文档”由归属字段表达，因此不能套用可见性过滤。
   */
  async listAll(): Promise<KnowledgeDocument[]> {
    const table = await this.storage.openExisting(DOCUMENTS_TABLE);
    if (!table) return [];
    const rows = await table.query().toArray();
    return rows.map(toDocument).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 文档总数（含全局与全部私有文档）：总览看整体规模，不做可见性过滤 */
  async count(): Promise<number> {
    const table = await this.storage.openExisting(DOCUMENTS_TABLE);
    return table ? table.countRows() : 0;
  }

  /** 写入文档：切分 → 批量向量化 → 分别写入文档表与片段表 */
  async add(input: KnowledgeUpload): Promise<KnowledgeDocument> {
    const { pieces, vectors, dim } = await this.embedPieces(input.content);

    const document: KnowledgeDocument = {
      id: randomUUID(),
      title: input.title,
      scope: input.scope,
      ownerUserId: input.scope === 'global' ? null : input.userId,
      chunks: pieces.length,
      createdAt: new Date().toISOString(),
    };

    const documents = await this.storage.ensure(DOCUMENTS_TABLE, documentsSchema());
    await documents.add([
      toDocumentRow(document, input.content, null, dim, this.options.embeddingModel),
    ]);

    const chunks = await this.storage.ensure(CHUNKS_TABLE, chunksSchema(dim));
    await chunks.add(
      pieces.map((content, index) =>
        toChunkRow(document, content, vectors[index] ?? [], document.createdAt),
      ),
    );
    return document;
  }

  /** 删除文档及其片段：管理员可删任意文档，普通用户仅限自己上传的；权限不足一律按「不存在」处理 */
  async remove(id: string, actor: KnowledgeActor): Promise<boolean> {
    if (!(await this.findDocument(id, actor, 'manage'))) return false;
    const documents = await this.storage.openExisting(DOCUMENTS_TABLE);
    await documents?.delete(`id = '${id}'`);
    const chunks = await this.storage.openExisting(CHUNKS_TABLE);
    await chunks?.delete(`document_id = '${id}'`);
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

    const chunks = await this.storage.openExisting(CHUNKS_TABLE);
    const rows = chunks ? await chunks.query().where(`document_id = '${id}'`).toArray() : [];
    return {
      document,
      content: rows.map((chunk) => String(chunk.content)).join('\n\n'),
      source: 'stitched',
      updatedAt,
    };
  }

  /**
   * 编辑文档：整体替换内容并重切分重向量化，id、归属与范围保持不变。
   * 不做逐分片编辑：分片是检索单元，单改文本会与向量不一致，
   * 且重叠区跨分片重复，就地改必然错乱。文档行用 delete + add 原位重建
   * （update 的 values 走 SQL 表达式，把用户文本拼进去会注入，禁止）
   */
  async replace(
    id: string,
    input: { title: string; content: string },
    actor: KnowledgeActor,
  ): Promise<KnowledgeDocument | null> {
    const row = await this.findDocument(id, actor, 'manage');
    if (!row) return null;

    const { pieces, vectors, dim } = await this.embedPieces(input.content);
    const document: KnowledgeDocument = {
      ...toDocument(row),
      title: input.title,
      chunks: pieces.length,
    };
    const updatedAt = new Date().toISOString();

    const chunks = await this.storage.ensure(CHUNKS_TABLE, chunksSchema(dim));
    await chunks.delete(`document_id = '${id}'`);
    await chunks.add(
      pieces.map((content, index) =>
        toChunkRow(document, content, vectors[index] ?? [], updatedAt),
      ),
    );

    const documents = await this.storage.ensure(DOCUMENTS_TABLE, documentsSchema());
    await documents.delete(`id = '${id}'`);
    await documents.add([
      toDocumentRow(document, input.content, updatedAt, dim, this.options.embeddingModel),
    ]);
    return document;
  }

  /** 检索：先按可见性过滤，再按余弦距离取前 topK 条 */
  async search(
    query: string,
    options: { userId: number; topK?: number },
  ): Promise<KnowledgeSearchResult[]> {
    const table = await this.storage.openExisting(CHUNKS_TABLE);
    if (!table || (await table.countRows()) === 0) return [];

    const vector = await this.storage.embedQuery(query);
    await this.storage.assertCompatible(vector.length);

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
    await this.storage.close();
  }
}
