import type { KnowledgeBaseView, KnowledgeDocument } from '../../entities/knowledge.js';
import type { KnowledgeBaseStore } from '../../mappers/knowledge/bases.js';
import type { UserStore } from '../../mappers/user/store.js';
import type { Logger } from '@mnemo/logger';

/**
 * 管理端知识库视图：文档与库的数据取自知识库域，这里只补「谁的」这一层视图信息。
 * 归属自库级表达（见 docs/adr/0018）：文档 → 所属库 → 库归属人 → 账号名，
 * 三层都批量取回——逐条查名会让一页列表产生 N 次往返。
 */

/** 文档列表项：文档字段 + 归属账号名（所属库无归属人或账号已删时为 null） */
export interface AdminDocument extends KnowledgeDocument {
  ownerName: string | null;
}

/** 库列表项：库字段 + 归属账号名（共享库无归属人） */
export interface AdminKnowledgeBase extends KnowledgeBaseView {
  ownerName: string | null;
}

/** 批量解析账号名：多层归属取去重后的 id 集一次查询 */
async function loadNames(
  users: Pick<UserStore, 'findNamesByIds'>,
  ownerIds: number[],
): Promise<Map<number, string>> {
  return users.findNamesByIds([...new Set(ownerIds)]);
}

/** 补上文档的归属账号名：所属库已删或库无归属人时为 null */
export async function attachOwnerNames(
  knowledgeBases: Pick<KnowledgeBaseStore, 'findByIds'>,
  users: Pick<UserStore, 'findNamesByIds'>,
  documents: KnowledgeDocument[],
): Promise<AdminDocument[]> {
  const baseIds = [...new Set(documents.map((document) => document.knowledgeBaseId))];
  const bases = await knowledgeBases.findByIds(baseIds);
  const ownerIds = [...bases.values()].flatMap((base) =>
    base.ownerUserId === null ? [] : [base.ownerUserId],
  );
  const names = await loadNames(users, ownerIds);
  return documents.map((document) => {
    const owner = bases.get(document.knowledgeBaseId)?.ownerUserId ?? null;
    return {
      ...document,
      ownerName: owner === null ? null : (names.get(owner) ?? null),
    };
  });
}

/** 管理端库列表：全部库（含各用户私有库），文档数由库 mapper 聚合，归属名在此补齐 */
export async function listAllBases(
  knowledgeBases: Pick<KnowledgeBaseStore, 'listAll'>,
  users: Pick<UserStore, 'findNamesByIds'>,
): Promise<AdminKnowledgeBase[]> {
  return attachBaseOwnerNames(users, await knowledgeBases.listAll());
}

/** 管理端删除库：不限制归属，文档与片段随外键级联删除，会话绑定回落为不限库 */
export async function removeBaseAsAdmin(
  knowledgeBases: Pick<KnowledgeBaseStore, 'remove'>,
  logger: Logger,
  id: string,
): Promise<boolean> {
  const removed = await knowledgeBases.remove(id);
  if (removed) logger.info('管理端删除知识库', { baseId: id });
  return removed;
}

/** 补上库的归属账号名：共享库（无归属人）与账号已删时为 null */
export async function attachBaseOwnerNames(
  users: Pick<UserStore, 'findNamesByIds'>,
  bases: KnowledgeBaseView[],
): Promise<AdminKnowledgeBase[]> {
  const ownerIds = bases.flatMap((base) => (base.ownerUserId === null ? [] : [base.ownerUserId]));
  const names = await loadNames(users, ownerIds);
  return bases.map((base) => ({
    ...base,
    ownerName: base.ownerUserId === null ? null : (names.get(base.ownerUserId) ?? null),
  }));
}
