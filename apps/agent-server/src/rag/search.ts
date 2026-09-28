export interface KnowledgeSearchResult {
  title: string;
  content: string;
  score: number;
}

/** 可见性过滤：全局文档对所有人生效，私有文档只对归属者生效 */
export function visibilityFilter(userId: number): string {
  if (!Number.isInteger(userId)) throw new Error('用户 ID 非法');
  return `(scope = 'global' OR owner_user_id = ${userId})`;
}
