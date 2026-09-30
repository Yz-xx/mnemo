import { randomUUID } from 'node:crypto';

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

/** 写入目标：scope 决定归属，全局文档只能由管理入口写入 */
export interface KnowledgeUpload {
  title: string;
  content: string;
  scope: KnowledgeScope;
  userId: number;
}

/** 操作者身份：管理员可删任意文档（含他人私有），普通用户仅限自己上传的私有文档 */
export interface KnowledgeActor {
  userId: number;
  isAdmin: boolean;
}

/**
 * 文档内容读取结果。source 标记内容来源：
 * raw 为库内存档的原文；stitched 为旧文档无原文、按分片顺序拼接的近似还原
 * （分片带重叠且段落已被切开，只能看个大概，保存一次编辑即留存正式原文）。
 */
export interface KnowledgeContent {
  document: KnowledgeDocument;
  content: string;
  source: 'raw' | 'stitched';
  /** 最后编辑时间；从未编辑过为 null */
  updatedAt: string | null;
}

/** 读取行上的归属用户：全局文档（或列缺失）一律按 null 处理 */
export function readOwner(row: Record<string, unknown>): number | null {
  return row.owner_user_id === null || row.owner_user_id === undefined
    ? null
    : Number(row.owner_user_id);
}

/** 读取行上的最后编辑时间：旧表无该列、空串哨兵或从未编辑过一律按 null 处理 */
export function readUpdatedAt(row: Record<string, unknown>): string | null {
  const value = row.updated_at;
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** 行 → 文档元数据：scope 只认 global，其余一律按 private 处理 */
export function toDocument(row: Record<string, unknown>): KnowledgeDocument {
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
 * 文档元数据 + 原文与编辑时间 → 文档行。
 * updated_at 是后补列：由 addColumns 补出的列被 Lance 记为 non-nullable，
 * 写 null 会让整批写入失败（旧表升级后的库上新增文档必然踩中），
 * 因此「从未编辑」落成空串哨兵，与迁移补列的 valueSql 一致，读取侧再还原成 null
 */
export function toDocumentRow(
  document: KnowledgeDocument,
  content: string,
  updatedAt: string | null,
  dim: number,
  embeddingModel: string,
): Record<string, unknown> {
  return {
    id: document.id,
    title: document.title,
    scope: document.scope,
    owner_user_id: document.ownerUserId,
    chunks: document.chunks,
    embedding_model: embeddingModel,
    dim,
    created_at: document.createdAt,
    content,
    updated_at: updatedAt ?? '',
  };
}

/** 文档元数据 + 分片内容与向量 → 分片行；created_at 记分片实际入库时间 */
export function toChunkRow(
  document: KnowledgeDocument,
  content: string,
  vector: number[],
  createdAt: string,
): Record<string, unknown> {
  return {
    id: randomUUID(),
    document_id: document.id,
    title: document.title,
    content,
    scope: document.scope,
    owner_user_id: document.ownerUserId,
    created_at: createdAt,
    vector,
  };
}
