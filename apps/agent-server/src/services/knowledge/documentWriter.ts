import type { ChunkPiece, EmbeddingContext } from './embedding.js';
import type {
  KnowledgeDocument,
  KnowledgeFileUpload,
  KnowledgeUpload,
} from '../../entities/knowledge.js';
import type {
  KnowledgeStoreOptions,
  KnowledgeVectorStore,
} from '../../mappers/knowledge/vectorStore.js';
import { randomUUID } from 'node:crypto';
import { toChunkRow, toDocument, toDocumentRow } from '../../mappers/knowledge/documents.js';
import { splitAndEmbed } from './embedding.js';

/**
 * 片段与向量按下标配对成行：splitAndEmbed 保证两者等长，缺位按空向量兜底。
 * 粘贴、解析回写、编辑重建三条写入路径共用这一份形状，避免同一映射复制三遍后漂移。
 */
function toChunkRows(
  document: KnowledgeDocument,
  pieces: ChunkPiece[],
  vectors: number[][],
  createdAt: string,
): ReturnType<typeof toChunkRow>[] {
  return pieces.map((piece, index) =>
    toChunkRow(document, piece.content, vectors[index] ?? [], createdAt, piece.page),
  );
}

/**
 * 文档写入生命周期：粘贴入库、上传待解析、解析回写、编辑重建。
 * 从 KnowledgeStore 抽出以控制单文件体量：这里只关心「内容 → 文档行 + 片段行」，
 * 权限与可见性判定仍留在 KnowledgeStore。
 */
export class KnowledgeDocumentWriter {
  constructor(
    private readonly store: KnowledgeVectorStore,
    private readonly options: KnowledgeStoreOptions,
    /** 向量化上下文用取值器延迟读取：它依赖 KnowledgeStore 自身的字段 */
    private readonly context: () => EmbeddingContext,
  ) {}

  /** 粘贴文本入库：切分向量化后同步写文档行与片段行，落库即 ready */
  async add(input: KnowledgeUpload): Promise<KnowledgeDocument> {
    const { pieces, vectors, dim } = await splitAndEmbed(this.context(), input.content);

    const document: KnowledgeDocument = {
      id: randomUUID(),
      title: input.title,
      knowledgeBaseId: input.knowledgeBaseId,
      chunks: pieces.length,
      createdAt: new Date().toISOString(),
      // 粘贴文本同步解析：入队即完成，不存在中间态
      fileName: null,
      fileSize: null,
      mimeType: null,
      status: 'ready',
      failureReason: null,
    };

    await this.store.ensureDocumentStore();
    await this.store.addDocument(
      toDocumentRow(document, input.content, null, dim, this.options.embeddingModel),
    );

    await this.store.ensureChunkStore(dim);
    await this.store.addChunks(toChunkRows(document, pieces, vectors, document.createdAt));
    return document;
  }

  /** 上传先落 processing 记录：正文与片段由异步解析任务回写 */
  async addPending(input: KnowledgeFileUpload): Promise<KnowledgeDocument> {
    const document: KnowledgeDocument = {
      id: input.id,
      title: input.title,
      knowledgeBaseId: input.knowledgeBaseId,
      chunks: 0,
      createdAt: new Date().toISOString(),
      fileName: input.fileName,
      fileSize: input.fileSize,
      mimeType: input.mimeType,
      status: 'processing',
      failureReason: null,
    };

    await this.store.ensureDocumentStore();
    // 尚无向量基准：dim 先记 0，解析完成回写时以实际维度覆盖；正文留空，等解析结果填入
    await this.store.addDocument(toDocumentRow(document, '', null, 0, this.options.embeddingModel));
    return document;
  }

  /**
   * 解析结果回写：切分向量化后原位重建片段，状态转 ready。
   * 文档在解析期间被删时返回 false（存储层用 UPDATE 判定，避免把已删文档写回来）。
   */
  async ingestContent(id: string, content: string): Promise<boolean> {
    const row = await this.store.findDocument(id);
    if (!row) return false;

    const { pieces, vectors, dim } = await splitAndEmbed(this.context(), content);
    const document: KnowledgeDocument = {
      ...toDocument(row),
      chunks: pieces.length,
      status: 'ready',
      failureReason: null,
    };
    const updatedAt = new Date().toISOString();

    await this.store.ensureChunkStore(dim);
    await this.store.ensureDocumentStore();
    return this.store.writeDocumentContent(
      id,
      toDocumentRow(document, content, updatedAt, dim, this.options.embeddingModel),
      toChunkRows(document, pieces, vectors, updatedAt),
    );
  }

  /** 编辑重建：标题与正文整体替换，id、所属库与创建时间保持不变 */
  async replace(
    id: string,
    row: Record<string, unknown>,
    input: { title: string; content: string },
  ): Promise<KnowledgeDocument> {
    const { pieces, vectors, dim } = await splitAndEmbed(this.context(), input.content);
    const document: KnowledgeDocument = {
      ...toDocument(row),
      title: input.title,
      chunks: pieces.length,
      // 编辑是一次完整重建：内容已就绪，失败态与原因随之清掉
      status: 'ready',
      failureReason: null,
    };
    const updatedAt = new Date().toISOString();

    await this.store.ensureChunkStore(dim);
    await this.store.ensureDocumentStore();
    await this.store.replaceDocument(
      id,
      toDocumentRow(document, input.content, updatedAt, dim, this.options.embeddingModel),
      toChunkRows(document, pieces, vectors, updatedAt),
    );
    return document;
  }
}
