import type {
  AdminConversation,
  AdminConversationQuery,
  AdminConversationSummary,
} from '../../entities/conversation.js';
import type { ConversationStore } from '../../mappers/conversation/conversations.js';
import type { UserStore } from '../../mappers/user/store.js';

/**
 * 管理端会话视图：数据取自会话存储，归属账号名在这里一次批量补上。
 * 逐条查名会让一页列表产生 N 次往返，因此补名统一收在本模块。
 */

export interface AdminConversationDeps {
  conversations: Pick<ConversationStore, 'listAll' | 'find'>;
  users: Pick<UserStore, 'findNamesByIds'>;
}

/** 列表项：会话摘要 + 归属账号名；账号已删时为 null */
export interface AdminConversationListItem extends AdminConversationSummary {
  ownerName: string | null;
}

/** 详情项：整条会话外带归属账号名，供后台核查对话内容 */
export interface AdminConversationDetail extends AdminConversation {
  ownerName: string | null;
}

/** 列表响应：分页字段原样回传给前端计算总页数 */
export interface AdminConversationListResponse {
  items: AdminConversationListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 管理端会话列表：关键词 + 分页 */
export async function listAdminConversations(
  deps: AdminConversationDeps,
  query: AdminConversationQuery,
): Promise<AdminConversationListResponse> {
  const { items, total } = await deps.conversations.listAll(query);
  const names = await deps.users.findNamesByIds(items.map((item) => item.userId));
  return {
    items: items.map((item) => ({ ...item, ownerName: names.get(item.userId) ?? null })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** 管理端会话详情：含全部消息，查不到返回 null */
export async function findAdminConversation(
  deps: AdminConversationDeps,
  id: string,
): Promise<AdminConversationDetail | null> {
  const conversation = await deps.conversations.find(id);
  if (!conversation) return null;
  const names = await deps.users.findNamesByIds([conversation.userId]);
  return { ...conversation, ownerName: names.get(conversation.userId) ?? null };
}
