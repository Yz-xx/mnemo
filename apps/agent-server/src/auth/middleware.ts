import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { SessionStore } from './sessionStore.js';

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
      res.status(401).json({ message: '登录已失效，请重新登录' });
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
