// 知识库文档管理接口：列表、新增、内容读取、编辑、删除与批量删除。
// 统一经 adminApi 发请求，鉴权由请求头里的 Bearer 令牌承担，此处不再重复拼装。
import type { AdminKnowledgeContent, AdminKnowledgeDocument, PageResult } from './types';
import { adminApi } from './client';

/** 知识库文档查询条件：keyword 按标题包含匹配 */
export interface KnowledgeQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 知识库文档列表：管理视角，含各用户的私有文档与归属账号名 */
export function listKnowledgeDocuments(
  query: KnowledgeQuery,
): Promise<PageResult<AdminKnowledgeDocument>> {
  return adminApi.get<PageResult<AdminKnowledgeDocument>>('/api/admin/knowledge/documents', {
    params: { keyword: query.keyword, page: query.page, pageSize: query.pageSize },
  });
}

/** 新增全局共享文档：入库时同步完成切分与向量化 */
export function createGlobalDocument(input: {
  title: string;
  content: string;
}): Promise<AdminKnowledgeDocument> {
  return adminApi.post<AdminKnowledgeDocument>('/api/admin/knowledge/documents', input);
}

/** 删除文档：管理端可删任意文档，其向量片段一并清除 */
export function deleteKnowledgeDocument(id: string): Promise<void> {
  return adminApi.delete<void>(`/api/admin/knowledge/documents/${id}`);
}

/** 文档内容：旧文档无原文时返回按分片拼接的近似还原（source 标记） */
export function fetchKnowledgeContent(id: string): Promise<AdminKnowledgeContent> {
  return adminApi.get<AdminKnowledgeContent>(`/api/admin/knowledge/documents/${id}/content`);
}

/** 编辑文档：整体替换内容，服务端重切分重向量化，id 与归属保持不变 */
export function updateKnowledgeDocument(
  id: string,
  input: { title: string; content: string },
): Promise<AdminKnowledgeDocument> {
  return adminApi.put<AdminKnowledgeDocument>(`/api/admin/knowledge/documents/${id}`, input);
}

// 批量操作统一走一个 POST 接口而不是前端循环调单条，
// 让「整体拒绝」这类跨条目的判定能在一个请求内完成（见 docs/adr/0003）。

/** 批量删除文档：管理端可删任意文档，不存在的条目视为已完成 */
export function batchDeleteKnowledgeDocuments(ids: string[]): Promise<void> {
  return adminApi.post<void>('/api/admin/knowledge/documents/batch-delete', { ids });
}
