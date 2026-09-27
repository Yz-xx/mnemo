import type { Express } from 'express';
import { createRequireAuth } from '../auth/middleware.js';
import type { AppDependencies } from '../configuration/dependencies.js';
import { createAuthRouter } from './auth.js';
import { createChatRouter } from './chat.js';
import { createConversationRouter } from './conversations.js';
import { createFilesRouter } from './files.js';
import { createHealthRouter } from './health.js';
import { createKnowledgeRouter } from './knowledge.js';

/**
 * 统一注册接口前缀与鉴权策略，新增接口时只需在此追加一行。
 * 健康检查与账号接口公开；对话、会话、文件与知识库均需登录后访问。
 * 各路由自己从 deps 里 Pick 用到的依赖，调用处因此形状一致。
 */
export function registerRoutes(app: Express, deps: AppDependencies): void {
  const requireAuth = createRequireAuth(deps.sessions);

  app.use('/api/health', createHealthRouter(deps));
  app.use('/api/auth', createAuthRouter(deps));
  app.use('/api/chat', requireAuth, createChatRouter(deps));
  app.use('/api/conversations', requireAuth, createConversationRouter(deps));
  app.use('/api/files', requireAuth, createFilesRouter(deps));
  app.use('/api/knowledge', requireAuth, createKnowledgeRouter(deps));
}
