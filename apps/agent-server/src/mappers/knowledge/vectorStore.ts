/**
 * 知识库向量存储接口（见 docs/adr/0012）。
 * 文档业务语义（切分、归属判定、access 可见性分档、文档 ID 白名单）留在 services/knowledge/store.ts；
 * 可见性过滤按存储方言在适配器内拼装（PostgreSQL 侧见 mappers/knowledge/pg.ts 的检索 SQL）；
 * 检索治理（闸门 / 熔断 / 超时 / 降级）留在 services/knowledge/retrieval.ts，
 * 这里只回答「文档与向量片段如何落到某个具体存储」——由 PostgreSQL + pgvector 适配器
 * （mappers/knowledge/pgStore.ts）满足。
 * 向量化（embedDocuments / embedQuery）属向量服务、与存储无关，不进本接口。
 */

import type { DocumentStatus } from '../../entities/knowledge.js';

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

/** 片段级检索命中：与业务侧检索结果同形，分数尚未做阈值过滤 */
export interface StoredChunkHit {
  /** 所属文档 ID：同一文档可能命中多个片段，去重与来源标签都以它为准 */
  documentId: string;
  /** 片段 ID：引用协议据此定位预览与高亮 */
  chunkId: string;
  title: string;
  content: string;
  /** 片段所在原始文件页码；文本来源或旧数据无定位信息时为 null */
  page: number | null;
  /** 相似度（1 - 余弦距离）；是否达标由检索层判定 */
  score: number;
}

/**
 * 存储接缝：写入类方法假定调用方已先建表（见 ensureDocumentStore / ensureChunkStore），
 * 读取类方法在表不存在时按「无数据」返回，不抛错。
 */
export interface KnowledgeVectorStore {
  /** 建 / 取文档表，保证结构最新 */
  ensureDocumentStore(): Promise<void>;
  /** 建 / 取片段表；向量维度在建表时固定，维度不符时写入会失败 */
  ensureChunkStore(dim: number): Promise<void>;
  /** 写入文档行（需先 ensureDocumentStore） */
  addDocument(row: Record<string, unknown>): Promise<void>;
  /** 批量写入片段行（需先 ensureChunkStore） */
  addChunks(rows: Record<string, unknown>[]): Promise<void>;
  /** 原位重建文档：先删旧片段与旧文档行，再写新片段与新文档行 */
  replaceDocument(
    id: string,
    document: Record<string, unknown>,
    chunks: Record<string, unknown>[],
  ): Promise<void>;
  /** 更新解析状态与失败原因；文档已被删除时返回 false */
  setDocumentStatus(
    id: string,
    status: DocumentStatus,
    failureReason: string | null,
  ): Promise<boolean>;
  /**
   * 回写解析结果并重建片段：只更新已存在的文档行，
   * 解析期间文档被删则返回 false 且不写片段，避免把已删文档写回来
   */
  writeDocumentContent(
    id: string,
    document: Record<string, unknown>,
    chunks: Record<string, unknown>[],
  ): Promise<boolean>;
  /** 删除文档及其全部片段 */
  removeDocument(id: string): Promise<void>;
  /** 按 id 取文档行，不存在返回 null */
  findDocument(id: string): Promise<Record<string, unknown> | null>;
  /** 取指定库内的文档行：库的可见性由服务层校验，这里只按库过滤 */
  listDocuments(baseId: string): Promise<Record<string, unknown>[]>;
  /** 取全部文档行，不做可见性过滤（管理端用） */
  listAllDocuments(): Promise<Record<string, unknown>[]>;
  /** 文档总数 */
  countDocuments(): Promise<number>;
  /** 片段总数：检索前判空用，空库可直接返回无命中，省一次向量化 */
  countChunks(): Promise<number>;
  /** 按分片顺序拼出文档正文：旧文档未存原文时的兜底还原 */
  stitchChunks(documentId: string): Promise<string>;
  /** 近邻检索：按预解析的库 id 清单预过滤后取相似度前 topK 条，分数不做阈值过滤 */
  searchChunks(
    vector: number[],
    options: { baseIds: string[]; topK: number },
  ): Promise<StoredChunkHit[]>;
  /** 校验向量维度与模型基准：换模型或换维度时抛错，避免新旧向量混算 */
  assertCompatible(dim: number): Promise<void>;
  /** 释放连接与文件句柄 */
  close(): Promise<void>;
}
