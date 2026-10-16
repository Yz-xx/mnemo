import type { StoredFile } from './types.js';
import type { QueryResultRow } from 'pg';

/** 管理端列表行：列集合比客户端多一个 user_id */
interface AdminFileRow extends FileRow {
  user_id: number;
}

interface TotalRow extends QueryResultRow {
  total: number;
}

interface FileRow extends QueryResultRow {
  id: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  created_at: Date;
}

/** 行转领域对象：日期与数值在这里统一归一，避免各调用方各自转换 */
export function toStoredFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    name: row.name,
    ext: row.ext,
    mime: row.mime,
    size: Number(row.size),
    createdAt: row.created_at.toISOString(),
  };
}

export type { AdminFileRow, FileRow, TotalRow };
