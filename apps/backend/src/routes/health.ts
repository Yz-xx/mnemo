import { Router } from 'express';
import { capitalize } from '@repo/shared';
import { describeChatModel } from '../config.js';
import type { AppConfig } from '../config.js';

/** 健康检查：同时返回当前对话模型与知识库状态，供客户端展示 */
export function createHealthRouter(config: AppConfig): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      service: capitalize('backend'),
      provider: config.llm.provider,
      model: describeChatModel(config),
      knowledgeEnabled: true,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
