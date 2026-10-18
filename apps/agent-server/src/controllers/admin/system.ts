import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { describeSystemConfig } from '../../configuration/config/index.js';

/**
 * 管理端系统信息：LLM 工具清单与运行期配置，均为只读展示。
 * 两者都取自运行时正在使用的定义（Agent 的工具实例、AppConfig），后台不会与实现各存一份。
 * 挂在 /api/admin/system；鉴权由 controllers/index.ts 统一挂 requireAdmin，本文件不接触任何依赖实例的写方法。
 */
export function createAdminSystemRouter({
  agent,
  config,
}: Pick<AppDependencies, 'agent' | 'config'>): Router {
  const router = Router();

  /** LLM 工具清单：名称、用途与参数名，用于核对模型当前能用哪些能力 */
  router.get('/tools', (_req: Request, res: Response) => {
    res.json({ items: agent.listTools() });
  });

  /** 系统配置：密钥类配置只回「是否已配置」，明文不出服务端 */
  router.get('/config', (_req: Request, res: Response) => {
    res.json(describeSystemConfig(config));
  });

  return router;
}
