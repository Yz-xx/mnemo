import type { KnowledgeDocument } from '../../entities/knowledge.js';
import { randomUUID } from 'node:crypto';

/** 读取行上的最后编辑时间：列值为空或从未编辑过一律按 null 处理 */
export function readUpdatedAt(row: Record<string, unknown>): string | null {
  const value = row.updated_at;
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** 可空文本列 → string | null：空串与缺失一律归为 null，避免列表上出现空文件名 */
function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** 行 → 文档元数据：归属由所在知识库表达（见 docs/adr/0018） */
export function toDocument(row: Record<string, unknown>): KnowledgeDocument {
  return {
    id: String(row.id),
    title: String(row.title),
    knowledgeBaseId: String(row.knowledge_base_id),
    chunks: Number(row.chunks),
    createdAt: String(row.created_at),
    fileName: nullableText(row.file_name),
    // bigint 经驱动读回是字符串，出口统一收敛成数字
    fileSize: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    mimeType: nullableText(row.mime_type),
    // 存量行没有状态列历史值时按 ready：迁移后默认值即达成
    status: (nullableText(row.status) as KnowledgeDocument['status']) ?? 'ready',
    failureReason: nullableText(row.failure_reason),
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
    knowledge_base_id: document.knowledgeBaseId,
    chunks: document.chunks,
    embedding_model: embeddingModel,
    dim,
    created_at: document.createdAt,
    content,
    updated_at: updatedAt,
    file_name: document.fileName,
    file_size: document.fileSize,
    mime_type: document.mimeType,
    status: document.status,
    failure_reason: document.failureReason,
  };
}

/** 文档元数据 + 分片内容、向量与页码 → 分片行；created_at 记分片实际入库时间 */
export function toChunkRow(
  document: KnowledgeDocument,
  content: string,
  vector: number[],
  createdAt: string,
  page: number | null,
): Record<string, unknown> {
  return {
    id: randomUUID(),
    document_id: document.id,
    knowledge_base_id: document.knowledgeBaseId,
    title: document.title,
    content,
    page,
    created_at: createdAt,
    vector,
  };
}
