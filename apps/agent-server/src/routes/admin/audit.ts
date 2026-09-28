import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { parsePaging } from '../pagination.js';

/**
 * 管理端操作审计：只读，记录由审计中间件在管理端写操作结束时自动写入。
 * 挂在 /api/admin/audit，模块内部只写相对路径；鉴权由 routes/index.ts 统一挂 requireAdmin。
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
    const { items, total } = await auditLogs.list({ keyword, page, pageSize });
    // 超级令牌入口没有账号 ID，先从集合里剔除再批量查名，避免让 IN 落进一个 NULL
    const actorIds = items.map((item) => item.actorId).filter((id): id is number => id !== null);
    const names = await users.findNamesByIds(actorIds);

    res.json({
      items: items.map((item) => ({
        ...item,
        actorName: item.actorId === null ? null : (names.get(item.actorId) ?? null),
      })),
      total,
      page,
      pageSize,
    });
  });

  return router;
}
