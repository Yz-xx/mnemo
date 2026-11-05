import type { EmbeddingContext } from './embedding.js';
import type { RetrievalGovernance } from './retrieval.js';
import type { KnowledgeBase } from '../../entities/knowledge.js';
import type {
  KnowledgeActor,
  KnowledgeContent,
  KnowledgeDocument,
  KnowledgeFileUpload,
  KnowledgeSearchResult,
  KnowledgeUpload,
} from '../../entities/knowledge.js';
import type {
  KnowledgeStoreOptions,
  KnowledgeVectorStore,
} from '../../mappers/knowledge/vectorStore.js';
import type { Embeddings } from '@langchain/core/embeddings';
import { readUpdatedAt, toDocument } from '../../mappers/knowledge/documents.js';
import { KnowledgeDocumentWriter } from './documentWriter.js';
import { retrieveChunks } from './retrieval.js';

/** 文档 ID 为 UUID：作为存储过滤条件前按白名单校验，避免注入 */
const DOCUMENT_ID = /^[0-9a-fA-F-]{36}$/;

/**
 * 库读取器接缝：检索与文档归属判定只需要这两个只读能力，
 * 由 KnowledgeBaseStore（mappers/knowledge/bases.ts）满足，单测注入轻量替身。
 */
export interface KnowledgeBaseReader {
  /** 按 id 取库：非 UUID 或不存在返回 null */
  find(id: string): Promise<KnowledgeBase | null>;
  /** 用户可见库的 id 清单：检索过滤前预解析（见 docs/adr/0018 决策 4） */
  visibleIds(userId: number): Promise<string[]>;
}

/**
 * 知识库：文档切分向量化后落库，检索走向量近邻 + 库集合过滤。
 * 可见性自库级表达（见 docs/adr/0018）：文档不再持有 scope / owner，
 * 权限、检索范围一律按所属库的 visibility / ownerUserId 判定。
 * 向量存储适配器由组合根装配（生产注入 PostgreSQL + pgvector 适配器，单测注入内存替身）：
 * 连接、建表、行读写、近邻查询、向量基准校验都收在适配器内；
 * 切分与向量化落在 embedding.ts，检索的闸门 / 超时 / 降级与熔断落在 retrieval.ts，
 * 这里只保留文档业务语义与库可见性判定，写入生命周期再下沉到 documentWriter.ts。
 */
export class KnowledgeStore {
  /** 文档写入生命周期：建记录、解析回写、编辑重建，与读路径分开 */
  private readonly writer: KnowledgeDocumentWriter;

  constructor(
    private readonly embeddings: Embeddings,
    private readonly options: KnowledgeStoreOptions,
    /** 向量存储适配器：接受依赖而非自建，单测据此注入替身 */
    private readonly store: KnowledgeVectorStore,
    /** 库读取器：文档归属判定与检索过滤集的来源 */
    private readonly bases: KnowledgeBaseReader,
    /** 检索与向量化治理：不传即不治理（本地脚本与单测），生产由组合根注入 */
    private readonly governance?: RetrievalGovernance,
  ) {
    this.writer = new KnowledgeDocumentWriter(store, options, () => this.embeddingContext);
  }

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
   * 按 id 取文档行：不存在或不可见一律按不存在处理（返回 null），不泄漏他人文档是否存在。
   * 访问口径分两档：visible 按库可见性（全局共享的 + 自己私有的），
   * manage 按库维护权（global 库仅管理令牌，private 库仅归属者）
   */
  private async findDocument(
    id: string,
    actor: KnowledgeActor,
    access: 'visible' | 'manage',
  ): Promise<Record<string, unknown> | null> {
    if (!DOCUMENT_ID.test(id)) return null;
    const row = await this.store.findDocument(id);
    if (!row) return null;
    const base = await this.bases.find(String(row.knowledge_base_id));
    if (!base) return null;
    const allowed =
      access === 'visible'
        ? base.visibility === 'global' || base.ownerUserId === actor.userId || actor.isAdmin
        : actor.isAdmin || (base.visibility === 'private' && base.ownerUserId === actor.userId);
    return allowed ? row : null;
  }

  /** 列出库内文档：库的可见性由服务层（路由入口）校验，这里只按库过滤 */
  async list(baseId: string): Promise<KnowledgeDocument[]> {
    const rows = await this.store.listDocuments(baseId);
    return rows.map(toDocument).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 管理端列表：不做可见性过滤，返回全部文档（含各用户的私有库文档）。
   * 后台看的是整体归置情况，「谁的文档」由所属库的归属字段表达
   */
  async listAll(): Promise<KnowledgeDocument[]> {
    const rows = await this.store.listAllDocuments();
    return rows.map(toDocument).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 文档总数（含全部库）：总览看整体规模，不做可见性过滤 */
  async count(): Promise<number> {
    return this.store.countDocuments();
  }

  /** 写入文档：切分 → 批量向量化 → 分别写入文档表与片段表（目标库由服务层校验归属） */
  async add(input: KnowledgeUpload): Promise<KnowledgeDocument> {
    return this.writer.add(input);
  }

  /**
   * 写入待解析记录：上传入口先落这条 processing 行，异步任务再补内容与片段。
   * 先建表再插入，避免全新部署时文件上传早于首次文本入库导致缺表。
   */
  async addPending(input: KnowledgeFileUpload): Promise<KnowledgeDocument> {
    return this.writer.addPending(input);
  }

  /** 按 id 取可见文档：不可见与不存在一律 null，供文档详情等读接口使用 */
  async findVisible(id: string, actor: KnowledgeActor): Promise<KnowledgeDocument | null> {
    const row = await this.findDocument(id, actor, 'visible');
    return row ? toDocument(row) : null;
  }

  /** 按 id 取可维护文档：供重试、删除等写接口判定权限 */
  async findManageable(id: string, actor: KnowledgeActor): Promise<KnowledgeDocument | null> {
    const row = await this.findDocument(id, actor, 'manage');
    return row ? toDocument(row) : null;
  }

  /**
   * 解析结果回写：切分向量化后原位重建片段，状态转 ready。
   * 文档在解析期间被删时返回 false（存储层用 UPDATE 判定，避免把已删文档写回来）。
   */
  async ingestContent(id: string, content: string): Promise<boolean> {
    return this.writer.ingestContent(id, content);
  }

  /** 标记解析失败：原因落库供 UI 展示与重试判断，文档不存在时静默跳过 */
  async markFailed(id: string, reason: string): Promise<void> {
    await this.store.setDocumentStatus(id, 'failed', reason.slice(0, 500));
  }

  /** 重置为 processing 供重试：只更新已存在的文档，返回是否命中 */
  async markProcessing(id: string): Promise<boolean> {
    return this.store.setDocumentStatus(id, 'processing', null);
  }

  /** 待解析文档：启动恢复扫描据此重新入队 */
  async listProcessing(): Promise<KnowledgeDocument[]> {
    return (await this.listAll()).filter((document) => document.status === 'processing');
  }

  /** 删除文档及其片段：维护权按所在库判定，权限不足一律按「不存在」处理 */
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
   * 编辑文档：整体替换内容并重切分重向量化，id 与所属库保持不变。
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
    return this.writer.replace(id, row, input);
  }

  /**
   * 检索：先解析库过滤集（绑定单个库或用户全部可见库），再按余弦距离取前 topK 条。
   * 读路径的闸门、超时与降级都在 services/knowledge/retrieval.ts 内完成，失败即返回空数组。
   * 指定了不可见的库时按「无结果」处理：工具路径不感知 404，HTTP 入口由路由层先行校验。
   */
  async search(
    query: string,
    options: { userId: number; knowledgeBaseId?: string; topK?: number },
  ): Promise<KnowledgeSearchResult[]> {
    const baseIds = await this.resolveBaseIds(options.userId, options.knowledgeBaseId);
    return retrieveChunks({
      store: this.store,
      embeddings: this.embeddings,
      options: this.options,
      governance: this.governance,
      query,
      baseIds,
      topK: options.topK,
    });
  }

  /**
   * 解析检索的库过滤集：绑定库时校验可见后单库检索，未绑定时取全部可见库。
   * 过滤集在检索前一次性解析（HNSW 扫描中不做 join），空集由检索层短路
   */
  private async resolveBaseIds(
    userId: number,
    knowledgeBaseId: string | undefined,
  ): Promise<string[]> {
    if (!knowledgeBaseId) return this.bases.visibleIds(userId);
    const base = await this.bases.find(knowledgeBaseId);
    if (!base) return [];
    return base.visibility === 'global' || base.ownerUserId === userId ? [knowledgeBaseId] : [];
  }

  /** 关闭连接并释放文件句柄，供停机与测试清理使用 */
  async close(): Promise<void> {
    await this.store.close();
  }
}
