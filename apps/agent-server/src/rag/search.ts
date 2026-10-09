export interface KnowledgeSearchResult {
  /** 所属文档 ID：同一文档可能命中多个片段，去重与来源标签都以它为准 */
  documentId: string;
  title: string;
  content: string;
  score: number;
}

/** 可见性过滤：全局文档对所有人生效，私有文档只对归属者生效 */
export function visibilityFilter(userId: number): string {
  if (!Number.isInteger(userId)) throw new Error('用户 ID 非法');
  return `(scope = 'global' OR owner_user_id = ${userId})`;
}
