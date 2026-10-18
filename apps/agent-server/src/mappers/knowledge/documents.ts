import type { KnowledgeDocument } from '../../entities/knowledge.js';
import { randomUUID } from 'node:crypto';

/** 读取行上的归属用户：全局文档（或列缺失）一律按 null 处理 */
export function readOwner(row: Record<string, unknown>): number | null {
  return row.owner_user_id === null || row.owner_user_id === undefined
    ? null
    : Number(row.owner_user_id);
}

/** 读取行上的最后编辑时间：列值为空或从未编辑过一律按 null 处理 */
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
 * updated_at 列可空：从未编辑过即落 null，读取侧 readUpdatedAt 统一还原
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
    updated_at: updatedAt,
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
