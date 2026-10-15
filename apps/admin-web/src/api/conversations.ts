// 会话管理接口：列表、详情、删除与批量删除（管理视角，含全部用户的会话）。
// 统一经 adminApi 发请求，鉴权由请求头里的 Bearer 令牌承担，此处不再重复拼装。
import type { AdminConversationDetail, AdminConversationSummary, PageResult } from './types';
import { adminApi } from './client';

/** 会话列表查询条件：keyword 按标题包含匹配 */
export interface ConversationQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 会话列表：管理视角，含全部用户的会话与归属账号名 */
export function listAdminConversations(
  query: ConversationQuery,
): Promise<PageResult<AdminConversationSummary>> {
  return adminApi.get<PageResult<AdminConversationSummary>>('/api/admin/conversations', {
    params: { keyword: query.keyword, page: query.page, pageSize: query.pageSize },
  });
}

/** 会话详情：含全部消息，供后台核查对话内容 */
export function fetchAdminConversation(id: string): Promise<AdminConversationDetail> {
  return adminApi.get<AdminConversationDetail>(`/api/admin/conversations/${id}`);
}

/** 删除会话：其全部消息一并清除 */
export function deleteAdminConversation(id: string): Promise<void> {
  return adminApi.delete<void>(`/api/admin/conversations/${id}`);
}

// 批量操作统一走一个 POST 接口而不是前端循环调单条，
// 让「整体拒绝」这类跨条目的判定能在一个请求内完成（见 docs/adr/0003）。

/** 批量删除会话：消息由外键级联清理，不存在的条目视为已完成 */
export function batchDeleteAdminConversations(ids: string[]): Promise<void> {
  return adminApi.post<void>('/api/admin/conversations/batch-delete', { ids });
}
