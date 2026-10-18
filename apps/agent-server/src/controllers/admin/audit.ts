import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { listAuditLogs } from '../../services/logging/auditLogs.js';
import { parsePaging } from '../../utils/pagination.js';

/**
 * 管理端操作审计：只读，记录由审计中间件在管理端写操作结束时自动写入。
 * 挂在 /api/admin/audit，模块内部只写相对路径；鉴权由 controllers/index.ts 统一挂 requireAdmin。
 */
export function createAdminAuditRouter({
  auditLogs,
  users,
}: Pick<AppDependencies, 'auditLogs' | 'users'>): Router {
  const router = Router();

  /** 审计列表：按路径包含匹配 + 分页，操作账号名一次批量还原 */
  router.get('/', async (req: Request, res: Response) => {
    const { page, pageSize } = parsePaging(req.query);
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';

    const query = { keyword, page, pageSize };
    const result = await listAuditLogs({ auditLogs, users }, query);
    res.json(result);
  });

  return router;
}
