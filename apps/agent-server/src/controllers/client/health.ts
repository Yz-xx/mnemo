import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { describeHealth } from '../../services/health/health.js';
import { describeReadiness } from '../../services/health/readiness.js';

/**
 * 健康检查分两级（见 docs/adr/0010 决策 17）：
 * `/` 只答「进程活着」——轻量、不受闸门影响，过载时运维仍能观测；
 * `/ready` 才探测 PostgreSQL / 模型 / 向量服务，并附闸门水位与指标快照，回答「现在能不能接活」。
 */
export function createHealthRouter({
  config,
  pool,
  guard,
  metrics,
}: Pick<AppDependencies, 'config' | 'pool' | 'guard' | 'metrics'>): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(describeHealth(config));
  });

  // 就绪检查同样不挂闸门：过载时运维更要能读到「卡在哪一环、哪一档满了」
  router.get('/ready', async (_req: Request, res: Response) => {
    res.json(await describeReadiness({ config, pool, guard, metrics }));
  });

  return router;
}
