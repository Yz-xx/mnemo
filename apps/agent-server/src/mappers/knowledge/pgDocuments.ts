import { DOCUMENTS_TABLE } from './pg.js';

/**
 * 文档表的 PostgreSQL 方言（见 docs/adr/0012）：
 * 列序、DDL、存量补列、文档读写 SQL 与行参数都收在这里。
 * 片段表与向量索引见 pgChunks.ts，表名与会话参数见 pg.ts。
 */

/** 文档表列序：插入参数必须与 toDocumentParams 一一对应 */
export const DOCUMENT_COLUMNS = [
  'id',
  'title',
  'knowledge_base_id',
  'chunks',
  'embedding_model',
  'dim',
  'created_at',
  'content',
  'updated_at',
  'file_name',
  'file_size',
  'mime_type',
  'status',
  'failure_reason',
] as const;

/**
 * 文档表 DDL：content 与 updated_at 可空——旧文档可能未留存原文与编辑时间。
 * 文件列与解析状态为迭代 2 新增，status 默认 ready 让存量文档直接可用。
 */
export function createDocumentsSql(): string {
  return `
CREATE TABLE IF NOT EXISTS ${DOCUMENTS_TABLE} (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases (id) ON DELETE CASCADE,
  chunks integer NOT NULL,
  embedding_model text NOT NULL,
  dim integer NOT NULL,
  created_at timestamptz(3) NOT NULL,
  content text NULL,
  updated_at timestamptz(3) NULL,
  file_name text NULL,
  file_size bigint NULL,
  mime_type text NULL,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
  failure_reason text NULL
)`.trim();
}

/**
 * 存量表补列：CREATE TABLE IF NOT EXISTS 不会给已有表加列，
 * 故每次初始化都幂等补一遍；CHECK 约束按名判存在，避免续跑重复添加。
 */
export const ADD_DOCUMENT_COLUMNS_SQL = `
ALTER TABLE ${DOCUMENTS_TABLE} ADD COLUMN IF NOT EXISTS file_name text NULL;
ALTER TABLE ${DOCUMENTS_TABLE} ADD COLUMN IF NOT EXISTS file_size bigint NULL;
ALTER TABLE ${DOCUMENTS_TABLE} ADD COLUMN IF NOT EXISTS mime_type text NULL;
ALTER TABLE ${DOCUMENTS_TABLE} ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE ${DOCUMENTS_TABLE} ADD COLUMN IF NOT EXISTS failure_reason text NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_documents_status_check'
  ) THEN
    ALTER TABLE ${DOCUMENTS_TABLE}
      ADD CONSTRAINT knowledge_documents_status_check
      CHECK (status IN ('processing', 'ready', 'failed'));
  END IF;
END $$`.trim();

export const FIND_DOCUMENT_SQL = `SELECT * FROM ${DOCUMENTS_TABLE} WHERE id = $1`;
/** 解析状态流转：失败原因随状态一并写，成功时清空 */
export const SET_DOCUMENT_STATUS_SQL = `UPDATE ${DOCUMENTS_TABLE} SET status = $2, failure_reason = $3 WHERE id = $1`;
/**
 * 解析结果回写：只更新已存在的行（rowCount=0 表示解析期间文档被删，调用方应放弃写片段）。
 * 用 UPDATE 而非 upsert，避免把用户已删除的文档写回来。
 */
export const UPDATE_DOCUMENT_CONTENT_SQL = `UPDATE ${DOCUMENTS_TABLE} SET
  title = $2,
  chunks = $3,
  embedding_model = $4,
  dim = $5,
  content = $6,
  updated_at = $7,
  status = $8,
  failure_reason = $9
WHERE id = $1`;
export const LIST_DOCUMENTS_SQL = `SELECT * FROM ${DOCUMENTS_TABLE} WHERE knowledge_base_id = $1`;
export const LIST_ALL_DOCUMENTS_SQL = `SELECT * FROM ${DOCUMENTS_TABLE}`;
export const COUNT_DOCUMENTS_SQL = `SELECT COUNT(*) AS count FROM ${DOCUMENTS_TABLE}`;
export const READ_BASELINE_SQL = `SELECT dim, embedding_model FROM ${DOCUMENTS_TABLE} LIMIT 1`;

/** 文档行 → 插入参数：updated_at 为空表示「从未编辑」 */
export function toDocumentParams(row: Record<string, unknown>): unknown[] {
  return [
    row.id,
    row.title,
    row.knowledge_base_id,
    row.chunks,
    row.embedding_model,
    row.dim,
    row.created_at,
    row.content,
    row.updated_at ? row.updated_at : null,
    row.file_name,
    row.file_size,
    row.mime_type,
    row.status,
    row.failure_reason,
  ];
}

/** 文档行 → 解析结果回写参数：列序与 UPDATE_DOCUMENT_CONTENT_SQL 一一对应 */
export function toDocumentUpdateParams(row: Record<string, unknown>): unknown[] {
  return [
    row.id,
    row.title,
    row.chunks,
    row.embedding_model,
    row.dim,
    row.content,
    row.updated_at ?? row.created_at,
    row.status,
    row.failure_reason,
  ];
}
