import type { AdminActor } from './actor.js';
import type { SessionStore } from './sessionStore.js';
import type { AppDependencies } from '../configuration/dependencies.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { ERROR_MESSAGE } from '../configuration/messages.js';
import { isAdminRole } from './userStore/index.js';

/** 从 Authorization: Bearer <token> 中取出令牌 */
function readToken(req: Request): string | null {
  const [scheme, token] = (req.get('authorization') ?? '').split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/**
 * 鉴权中间件：校验通过后把用户信息挂到 res.locals。
 * 放在 res.locals 而非 req 上，可避免为扩展 Express.Request 引入全局类型声明。
 */
export function createRequireAuth(sessions: SessionStore): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readToken(req);
    const userId = token ? await sessions.resolve(token) : null;
    if (!userId || !token) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.SESSION_EXPIRED });
      return;
    }
    res.locals.userId = userId;
    res.locals.token = token;
    next();
  };
}

/** 读取鉴权中间件写入的用户 ID（仅在挂载了 requireAuth 的路由中调用） */
export function currentUserId(res: Response): number {
  return res.locals.userId as number;
}

/** 读取当前请求携带的令牌，用于登出时删除对应会话 */
export function currentToken(res: Response): string {
  return res.locals.token as string;
}

/**
 * 管理端鉴权：两条入口任一成立即放行。
 * - 运维超级令牌：请求头 x-admin-token 与 KNOWLEDGE_ADMIN_TOKEN 一致（与知识库全局文档写入共用同一枚，
 *   留空即关闭），用于尚无管理员账号时开通后台，或管理员被锁在门外时的应急通道。
 * - 管理员会话：Bearer 令牌对应用户属于后台侧角色（ADMIN_ROLES）且 status 为 active。
 *
 * 无令牌按 401 处理；已登录但权限不足按「资源不存在」返回 404（backend-design 第 4 章），
 * 不向非管理员暴露管理接口的存在。
 */
export function createRequireAdmin({
  users,
  sessions,
  config,
}: Pick<AppDependencies, 'users' | 'sessions' | 'config'>): RequestHandler {
  const adminToken = config.knowledge.adminToken;

  return async (req: Request, res: Response, next: NextFunction) => {
    if (adminToken !== '' && req.get('x-admin-token') === adminToken) {
      const actor: AdminActor = { userId: null, superToken: true, role: null };
      res.locals.admin = actor;
      next();
      return;
    }

    const token = readToken(req);
    const userId = token ? await sessions.resolve(token) : null;
    if (!userId || !token) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.SESSION_EXPIRED });
      return;
    }
    const user = await users.findById(userId);
    if (!user || !isAdminRole(user.role) || user.status !== 'active') {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    // 一并写入 userId：请求日志据此把管理操作归到具体账号名下
    res.locals.userId = userId;
    res.locals.token = token;
    const actor: AdminActor = { userId, superToken: false, role: user.role };
    res.locals.admin = actor;
    next();
  };
}

/** 读取管理端身份（仅在挂载了 requireAdmin 的路由中调用） */
export function currentAdmin(res: Response): AdminActor {
  return res.locals.admin as AdminActor;
}
