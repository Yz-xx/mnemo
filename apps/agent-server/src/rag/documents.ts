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

/** 读取行上的归属用户：全局文档（或列缺失）一律按 null 处理 */
export function readOwner(row: Record<string, unknown>): number | null {
  return row.owner_user_id === null || row.owner_user_id === undefined
    ? null
    : Number(row.owner_user_id);
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
