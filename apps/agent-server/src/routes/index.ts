import type { AppDependencies } from '../configuration/dependencies.js';
import type { Express } from 'express';
import { createRequireAdmin, createRequireAuth } from '../auth/middleware.js';
import { createAdminAudit } from '../middleware/adminAudit.js';
import { createAdminAuditRouter } from './admin/audit.js';
import { createAdminAuthRouter } from './admin/auth.js';
import { createAdminConversationsRouter } from './admin/conversations.js';
import { createAdminFilesRouter } from './admin/files.js';
import { createAdminKnowledgeRouter } from './admin/knowledge.js';
import { createAdminLogsRouter } from './admin/logs.js';
import { createAdminOverviewRouter } from './admin/overview.js';
import { createAdminSystemRouter } from './admin/system.js';
import { createAdminUsersRouter } from './admin/users.js';
import { createAuthRouter } from './client/auth.js';
import { createChatRouter } from './client/chat.js';
import { createConversationRouter } from './client/conversations.js';
import { createFilesRouter } from './client/files.js';
import { createHealthRouter } from './client/health.js';
import { createKnowledgeRouter } from './client/knowledge.js';

/**
 * 统一注册接口前缀与鉴权策略，新增接口时只需在此追加一行。
 * 健康检查与账号接口公开；对话、会话、文件与知识库需登录后访问；管理后台需管理员身份。
 * 各路由自己从 deps 里 Pick 用到的依赖，调用处因此形状一致。
 */
export function registerRoutes(app: Express, deps: AppDependencies): void {
  const requireAuth = createRequireAuth(deps.sessions);
  const requireAdmin = createRequireAdmin(deps);

  app.use('/api/health', createHealthRouter(deps));
  app.use('/api/auth', createAuthRouter(deps));
  app.use('/api/chat', requireAuth, createChatRouter(deps));
  app.use('/api/conversations', requireAuth, createConversationRouter(deps));
  app.use('/api/files', requireAuth, createFilesRouter(deps));
  app.use('/api/knowledge', requireAuth, createKnowledgeRouter(deps));
  // 管理端：各组统一先鉴权、再登记写操作审计，新增管理接口不必再记得补记审计。
  // 更具体的路径一律排在最后那条 /api/admin（总览）之前——app.use 是前缀匹配，
  // 排在前面时同一次请求会先跑一遍守卫、再落到具体模块，鉴权与审计都要重复一次。
  const adminGuard = [requireAdmin, createAdminAudit(deps.auditLogs)];
  // 后台登录必须排在总览之前：/api/admin 挂的是 requireAdmin，登录请求会在守卫处被拦下
  app.use('/api/admin/auth', createAdminAuthRouter(deps));
  app.use('/api/admin/audit', adminGuard, createAdminAuditRouter(deps));
  app.use('/api/admin/conversations', adminGuard, createAdminConversationsRouter(deps));
  app.use('/api/admin/files', adminGuard, createAdminFilesRouter(deps));
  app.use('/api/admin/knowledge', adminGuard, createAdminKnowledgeRouter(deps));
  app.use('/api/admin/logs', adminGuard, createAdminLogsRouter(deps));
  app.use('/api/admin/system', adminGuard, createAdminSystemRouter(deps));
  app.use('/api/admin/users', adminGuard, createAdminUsersRouter(deps));
  app.use('/api/admin', adminGuard, createAdminOverviewRouter(deps));
}
