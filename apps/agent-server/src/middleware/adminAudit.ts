import type { AuditLogStore } from '../audit/store.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { currentAdmin } from '../auth/middleware.js';
import { hasContent, summarize } from '../logging/summarize.js';
import { requestLogger } from './requestLog.js';

/** 需要留档的写方法：读操作不记，否则审计页会被 GET 淹没 */
const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 管理端操作审计：登记管理端的每一次写尝试（含失败），供回溯「谁在什么时候改了什么」。
 *
 * 挂在管理端分组上而不是在各个路由里手写调用：新增管理接口时无需再记得补记一笔，
 * 也不会出现「有的接口记、有的忘了记」。前置条件是同组内先跑 requireAdmin——
 * 操作人从 res.locals.admin 取，鉴权没过就不会走到这里。
 *
 * 与接口日志一样落在 res.on('finish') 之后并 fire-and-forget：失败只告警，不影响响应。
 */
export function createAdminAudit(auditLogs: AuditLogStore): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!AUDITED_METHODS.has(req.method)) {
      next();
      return;
    }
    const actor = currentAdmin(res);
    res.on('finish', () => {
      const detail = hasContent(req.body) ? summarize(req.body) : null;
      void auditLogs
        .record({
          actorId: actor.userId,
          method: req.method,
          // 查询串不入库：写操作的目标在路径里，筛选条件不属于「改了什么」
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          detail,
        })
        .catch((error: unknown) => requestLogger(res).warn('操作审计落库失败', { error }));
    });
    next();
  };
}
