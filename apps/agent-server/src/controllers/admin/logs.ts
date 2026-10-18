import type { AppDependencies } from '../../configuration/dependencies.js';
import type { ApiLogStatusKind } from '../../entities/apiLog.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { listApiLogs } from '../../services/logging/apiLogs.js';
import { parsePaging } from '../../utils/pagination.js';

/** 方法白名单：只允许按已知方法过滤，避免拿任意串去比 method 列 */
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

/** 状态档位白名单：非法取值回落到 all，筛选参数不值得单独回 400 */
const STATUS_KINDS = ['all', 'client', 'server'] as const;

/** 从查询串里取白名单内的值：不在名单内返回 null，由调用方决定回退到什么 */
function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find((item) => item === value) ?? null;
}

/**
 * 管理端 API 日志：请求日志在响应结束时自动落 api_logs 表，本接口只做检索。
 * 挂在 /api/admin/logs，模块内部只写相对路径；鉴权由 controllers/index.ts 统一挂 requireAdmin。
 */
export function createAdminLogsRouter({ apiLogs }: Pick<AppDependencies, 'apiLogs'>): Router {
  const router = Router();

  /** 日志列表：路径关键词 + 方法 + 状态档位过滤，按时间倒序分页 */
  router.get('/', async (req: Request, res: Response) => {
    const { page, pageSize } = parsePaging(req.query);
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const method = pick(req.query.method, METHODS) ?? '';
    const statusKind: ApiLogStatusKind = pick(req.query.status, STATUS_KINDS) ?? 'all';

    const query = { keyword, method, statusKind, page, pageSize };
    const result = await listApiLogs(apiLogs, query);
    res.json(result);
  });

  return router;
}
