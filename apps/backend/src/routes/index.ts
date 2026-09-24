import type { Express } from 'express';
import { createRequireAuth } from '../auth/middleware.js';
import type { AppDependencies } from '../dependencies.js';
import { createAuthRouter } from './auth.js';
import { createChatRouter } from './chat.js';
import { createConversationRouter } from './conversations.js';
import { createHealthRouter } from './health.js';
import { createKnowledgeRouter } from './knowledge.js';

/**
 * 统一注册接口前缀与鉴权策略，新增接口时只需在此追加一行。
 * 健康检查与账号接口公开；对话、会话与知识库均需登录后访问。
 */
export function registerRoutes(app: Express, deps: AppDependencies): void {
  const { config, conversations, knowledge, sessions } = deps;
  const requireAuth = createRequireAuth(sessions);

  app.use('/api/health', createHealthRouter(config));
  app.use('/api/auth', createAuthRouter(deps));
  app.use('/api/chat', requireAuth, createChatRouter(deps));
  app.use('/api/conversations', requireAuth, createConversationRouter(conversations));
  app.use('/api/knowledge', requireAuth, createKnowledgeRouter(knowledge));
}
