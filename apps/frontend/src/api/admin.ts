// 管理后台接口：总览统计、运行状态、用户管理、知识库文档、会话、文件、接口日志与操作审计。
// 统一经 adminApi 发请求，鉴权由请求头里的 Bearer 令牌承担，此处不再重复拼装。
import type {
  AdminConversationDetail,
  AdminConversationSummary,
  AdminFileItem,
  AdminHealth,
  AdminKnowledgeDocument,
  AdminStats,
  AdminSystemConfig,
  AdminToolItem,
  AdminUser,
  ApiLogItem,
  ApiLogStatusKind,
  AuditLogItem,
  PageResult,
  UserRole,
  UserStatus,
} from './types';
import { adminApi } from './client';

/** 用户列表查询条件：keyword 为空表示不做过滤 */
export interface UserQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 知识库文档查询条件：keyword 按标题包含匹配 */
export interface KnowledgeQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 总览统计 */
export function fetchStats(): Promise<AdminStats> {
  return adminApi.request<AdminStats>('/api/admin/stats');
}

/** 运行状态 */
export function fetchHealth(): Promise<AdminHealth> {
  return adminApi.request<AdminHealth>('/api/admin/health');
}

/** 用户列表（分页） */
export function listUsers(query: UserQuery): Promise<PageResult<AdminUser>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<AdminUser>>(`/api/admin/users?${params.toString()}`);
}

/** 新建用户：角色由管理端指定 */
export function createUser(input: {
  username: string;
  password: string;
  role: UserRole;
}): Promise<AdminUser> {
  return adminApi.request<AdminUser>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 变更角色或状态：只传需要改的字段 */
export function updateUser(
  id: number,
  patch: { role?: UserRole; status?: UserStatus },
): Promise<AdminUser> {
  return adminApi.request<AdminUser>(`/api/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** 删除用户：服务端会连带清理其会话、对话与上传文件 */
export function deleteUser(id: number): Promise<void> {
  return adminApi.request<void>(`/api/admin/users/${id}`, { method: 'DELETE' });
}

/** 知识库文档列表：管理视角，含各用户的私有文档与归属账号名 */
export function listKnowledgeDocuments(
  query: KnowledgeQuery,
): Promise<PageResult<AdminKnowledgeDocument>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<AdminKnowledgeDocument>>(
    `/api/admin/knowledge/documents?${params.toString()}`,
  );
}

/** 新增全局共享文档：入库时同步完成切分与向量化 */
export function createGlobalDocument(input: {
  title: string;
  content: string;
}): Promise<AdminKnowledgeDocument> {
  return adminApi.request<AdminKnowledgeDocument>('/api/admin/knowledge/documents', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 删除文档：管理端可删任意文档，其向量片段一并清除 */
export function deleteKnowledgeDocument(id: string): Promise<void> {
  return adminApi.request<void>(`/api/admin/knowledge/documents/${id}`, { method: 'DELETE' });
}

/** 接口日志查询条件：method 为空串、status 为 all 时表示不做该维度过滤 */
export interface ApiLogQuery {
  keyword: string;
  method: string;
  status: ApiLogStatusKind;
  page: number;
  pageSize: number;
}

/** 接口日志列表：日志由服务端自动采集，此处只读 */
export function listApiLogs(query: ApiLogQuery): Promise<PageResult<ApiLogItem>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    method: query.method,
    status: query.status,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<ApiLogItem>>(`/api/admin/logs?${params.toString()}`);
}

/** 会话列表查询条件：keyword 按标题包含匹配 */
export interface ConversationQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 文件列表查询条件：keyword 按文件名包含匹配 */
export interface FileQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 会话列表：管理视角，含全部用户的会话与归属账号名 */
export function listAdminConversations(
  query: ConversationQuery,
): Promise<PageResult<AdminConversationSummary>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<AdminConversationSummary>>(
    `/api/admin/conversations?${params.toString()}`,
  );
}

/** 会话详情：含全部消息，供后台核查对话内容 */
export function fetchAdminConversation(id: string): Promise<AdminConversationDetail> {
  return adminApi.request<AdminConversationDetail>(`/api/admin/conversations/${id}`);
}

/** 删除会话：其全部消息一并清除 */
export function deleteAdminConversation(id: string): Promise<void> {
  return adminApi.request<void>(`/api/admin/conversations/${id}`, { method: 'DELETE' });
}

/** 文件列表：管理视角，含全部用户的上传文件与归属账号名 */
export function listAdminFiles(query: FileQuery): Promise<PageResult<AdminFileItem>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<AdminFileItem>>(`/api/admin/files?${params.toString()}`);
}

/** 删除文件：元数据与落盘字节一并清理 */
export function deleteAdminFile(id: string): Promise<void> {
  return adminApi.request<void>(`/api/admin/files/${id}`, { method: 'DELETE' });
}

/** 审计查询条件：keyword 按请求路径包含匹配 */
export interface AuditQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 操作审计列表：只记管理端写操作，由服务端自动登记，此处只读 */
export function listAuditLogs(query: AuditQuery): Promise<PageResult<AuditLogItem>> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return adminApi.request<PageResult<AuditLogItem>>(`/api/admin/audit?${params.toString()}`);
}

/** LLM 工具清单：只读，取自服务端运行时注入 Agent 的同一份工具定义 */
export function listAdminTools(): Promise<AdminToolItem[]> {
  // 服务端与其他列表接口统一返回 { items } 信封，这里就地解包，页面拿到的就是清单本身
  return adminApi
    .request<{ items: AdminToolItem[] }>('/api/admin/system/tools')
    .then((result) => result.items);
}

/** 系统配置：只读，密钥类配置只回是否已配置 */
export function fetchSystemConfig(): Promise<AdminSystemConfig> {
  return adminApi.request<AdminSystemConfig>('/api/admin/system/config');
}

// 以下为批量操作：统一走一个 POST 接口而不是前端循环调单条，
// 让「整体拒绝」这类跨条目的判定能在一个请求内完成（见 docs/adr 关于批量删除语义的记录）。

/** 批量停用 / 启用用户：返回实际变更的条数 */
export function batchUpdateUserStatus(
  ids: number[],
  status: UserStatus,
): Promise<{ updated: number }> {
  return adminApi.request<{ updated: number }>('/api/admin/users/batch-status', {
    method: 'POST',
    body: JSON.stringify({ ids, status }),
  });
}

/** 批量删除用户：服务端按整批预检，任一项不可删（含当前登录账号、最后一名可登录管理员）则整批拒绝 */
export function batchDeleteUsers(ids: number[]): Promise<void> {
  return adminApi.request<void>('/api/admin/users/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

/** 批量删除文档：管理端可删任意文档，不存在的条目视为已完成 */
export function batchDeleteKnowledgeDocuments(ids: string[]): Promise<void> {
  return adminApi.request<void>('/api/admin/knowledge/documents/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

/** 批量删除文件：元数据与落盘字节一并清理，不存在的条目视为已完成 */
export function batchDeleteAdminFiles(ids: string[]): Promise<void> {
  return adminApi.request<void>('/api/admin/files/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

/** 批量删除会话：消息由外键级联清理，不存在的条目视为已完成 */
export function batchDeleteAdminConversations(ids: string[]): Promise<void> {
  return adminApi.request<void>('/api/admin/conversations/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}
