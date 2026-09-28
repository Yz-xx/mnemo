// 与后端约定的接口返回结构：登录态、用户、管理端统计、日志与审计等。
// 这里刻意不从 @repo/reusable 复用，理由见 docs/adr/0002：两端的同名字段并不真正同构，
// 合并只会让桌面端看到管理端专属字段。代价是需要两侧同步——本文件对应 agent-server 的
// routes/{auth,admin,admin*}.ts 返回结构，后端改字段时同步这里。

/** 角色：admin 可登录管理后台，user 仅能使用桌面端 */
export type UserRole = 'admin' | 'user';

/** 账号状态：banned 禁止登录 */
export type UserStatus = 'active' | 'banned';

/** 当前登录用户：登录响应与 /api/auth/me 返回的结构 */
export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
}

/** 登录响应：token 与用户信息 */
export interface AuthSession {
  token: string;
  user: AuthUser;
}

/** 管理端用户列表项：在登录态四个字段之上多一个创建时间，供列表展示 */
export interface AdminUser extends AuthUser {
  createdAt: string;
}

/** 分页响应：items 为当前页数据，total 为满足条件的总数 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 账号汇总：总数与活跃/停用/管理员三项计数 */
export interface UserStats {
  total: number;
  active: number;
  banned: number;
  admins: number;
}

/** 消息趋势的一个数据点：date 为 YYYY-MM-DD */
export interface MessageTrendPoint {
  date: string;
  count: number;
}

/** 总览统计：用户规模、会话与消息量、近 7 天趋势、知识库文档数 */
export interface AdminStats {
  users: UserStats;
  conversations: {
    total: number;
    messages: number;
    messagesToday: number;
  };
  messageTrend: MessageTrendPoint[];
  knowledge: { documents: number };
  generatedAt: string;
}

/** 运行状态：健康检查六项 + 运行时长与数据库目标 */
export interface AdminHealth {
  status: string;
  service: string;
  provider: string;
  model: string;
  knowledgeEnabled: boolean;
  timestamp: string;
  uptimeSeconds: number;
  mysql: string;
}

/** 文档可见范围：global 全局共享，private 仅上传者本人可见 */
export type KnowledgeScope = 'global' | 'private';

/** 管理端知识库文档：在文档字段之上带归属账号名，全局文档为 null */
export interface AdminKnowledgeDocument {
  id: string;
  title: string;
  scope: KnowledgeScope;
  ownerUserId: number | null;
  ownerName: string | null;
  chunks: number;
  createdAt: string;
}

/** 接口日志状态档位：all 不限、client 只看 4xx、server 只看 5xx */
export type ApiLogStatusKind = 'all' | 'client' | 'server';

/** 接口请求日志：由服务端在响应结束时自动落库，管理端只读 */
export interface ApiLogItem {
  id: number;
  /** 8 位请求 ID，与服务端日志文件中的 requestId 一致 */
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** 登录用户 ID；未登录与运维超级令牌入口为 null */
  userId: number | null;
  queryParams: string | null;
  requestBody: string | null;
  responseBody: string | null;
  /** 错误摘要，仅 5xx 有值 */
  error: string | null;
  createdAt: string;
}

/** 消息角色：与桌面端会话历史同构 */
export type MessageRole = 'user' | 'assistant' | 'system';

/** 管理端消息：只读展示，工具、附件与检索来源按需还原为标签 */
export interface AdminMessage {
  id: string;
  role: MessageRole;
  content: string;
  tools?: string[];
  attachments?: string[];
  sources?: string[];
  createdAt: string;
}

/** 管理端会话摘要：含所属用户与归属账号名 */
export interface AdminConversationSummary {
  id: string;
  userId: number;
  ownerName: string | null;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 管理端会话详情：整条会话外带归属账号名 */
export interface AdminConversationDetail {
  id: string;
  userId: number;
  ownerName: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AdminMessage[];
}

/** 管理端文件：在文件元数据之上带上传者与归属账号名 */
export interface AdminFileItem {
  id: string;
  userId: number;
  ownerName: string | null;
  name: string;
  ext: string;
  mime: string;
  size: number;
  createdAt: string;
}

/** 管理端写操作审计：服务端在写操作结束时自动登记，管理端只读 */
export interface AuditLogItem {
  id: number;
  /** 操作管理员 ID；经运维超级令牌进入时为 null */
  actorId: number | null;
  /** 操作账号名；账号已删除或经超级令牌进入时为 null */
  actorName: string | null;
  method: string;
  path: string;
  status: number;
  /** 请求体摘要，已脱敏并截断 */
  detail: string | null;
  createdAt: string;
}

/** LLM 工具清单项：名称、用途与参数名，用于核对模型当前能用哪些能力 */
export interface AdminToolItem {
  name: string;
  description: string;
  params: string[];
}

/** 管理端系统配置：密钥类字段只给「是否已配置」，明文不出服务端 */
export interface AdminSystemConfig {
  port: number;
  dataDir: string;
  llm: {
    provider: string;
    model: string;
    endpoint: string;
    temperature: number;
    /** 仅线上提供方有此字段；本地 Ollama 不需要密钥 */
    apiKeyConfigured?: boolean;
  };
  embedding: {
    provider: string;
    model: string;
    endpoint: string;
    apiKeyConfigured?: boolean;
  };
  knowledge: {
    chunkSize: number;
    chunkOverlap: number;
    topK: number;
    minScore: number;
    adminTokenConfigured: boolean;
  };
  upload: {
    dir: string;
    maxBytes: number;
    maxFiles: number;
    allowedTypes: string[];
  };
  log: {
    level: string;
    dir: string;
    retentionDays: number;
  };
  mysql: {
    host: string;
    port: number;
    user: string;
    database: string;
    passwordConfigured: boolean;
  };
}
