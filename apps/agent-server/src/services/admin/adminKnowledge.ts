import type { KnowledgeDocument } from '../../entities/knowledge.js';
import type { UserStore } from '../../mappers/user/store.js';

/**
 * 管理端知识库视图：文档数据取自知识库服务，这里只补「谁的文档」这一层视图信息，
 * 归属账号名统一批量取回——逐条查名会让一页列表产生 N 次往返。
 */

/** 列表项：文档字段 + 归属账号名；全局文档与账号已删时为 null */
export interface AdminDocument extends KnowledgeDocument {
  ownerName: string | null;
}

/** 取这些文档的归属账号名：全局文档（ownerUserId 为 null）不参与查询 */
export function loadOwnerNames(
  users: Pick<UserStore, 'findNamesByIds'>,
  documents: KnowledgeDocument[],
): Promise<Map<number, string>> {
  const ids = documents.flatMap((document) =>
    document.ownerUserId === null ? [] : [document.ownerUserId],
  );
  return users.findNamesByIds(ids);
}

/** 补上归属账号名：查不到账号（已删）或全局文档时为 null */
export function withOwnerName(
  document: KnowledgeDocument,
  names: Map<number, string>,
): AdminDocument {
  return {
    ...document,
    ownerName: document.ownerUserId === null ? null : (names.get(document.ownerUserId) ?? null),
  };
}
