import type { AppDependencies } from '../../configuration/dependencies.js';
import { Router } from 'express';
import { describeHealth } from '../../services/health.js';

/** 健康检查：同时返回当前对话模型与知识库状态，供客户端展示 */
export function createHealthRouter({ config }: Pick<AppDependencies, 'config'>): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(describeHealth(config));
  });

  return router;
}
