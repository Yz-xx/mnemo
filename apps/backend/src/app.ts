import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { capitalize } from '@repo/shared';
import { describeChatModel } from './config.js';
import type { AppConfig } from './config.js';
import type { ConversationStore } from './conversation/store.js';
import type { AgentService } from './llm/agent.js';
import type { KnowledgeStore } from './rag/store.js';
import { createChatRouter } from './routes/chat.js';
import { createConversationRouter } from './routes/conversations.js';
import { createKnowledgeRouter } from './routes/knowledge.js';

export interface AppDependencies {
  config: AppConfig;
  agent: AgentService;
  conversations: ConversationStore;
  knowledge: KnowledgeStore;
}

/** 桌面客户端可能以 file:// 加载页面（Origin 为 null），统一放开跨域 */
function allowCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

// 拆分 app 创建逻辑，便于后续接入 supertest 做接口测试
export function createApp({ config, agent, conversations, knowledge }: AppDependencies): Express {
  const app = express();

  app.use(allowCors);
  app.use(express.json({ limit: '2mb' }));

  // 健康检查：同时返回当前对话模型与知识库状态，供客户端展示
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: capitalize('backend'),
      provider: config.llm.provider,
      model: describeChatModel(config),
      knowledgeEnabled: true,
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/chat', createChatRouter({ config, agent, conversations, knowledge }));
  app.use('/api/conversations', createConversationRouter(conversations));
  app.use('/api/knowledge', createKnowledgeRouter(knowledge));

  // 兜底错误处理：避免异常导致连接悬挂，并透传请求体解析等客户端错误的状态码
  app.use(
    (error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
      const status = error.status ?? 500;
      if (status >= 500) console.error('[backend] 请求处理失败:', error);
      if (!res.headersSent) {
        res.status(status).json({ message: status >= 500 ? '服务内部错误' : error.message });
      }
    },
  );

  return app;
}
