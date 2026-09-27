import { Router } from 'express';
import type { Request, Response } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import type { AppDependencies } from '../dependencies.js';
import { parseCredentials } from '../auth/credentials.js';
import { createRequireAuth, currentToken, currentUserId } from '../auth/middleware.js';
import type { SessionStore } from '../auth/sessionStore.js';
import type { UserRecord } from '../auth/userStore.js';
import { ERROR_MESSAGE } from '../messages.js';
import { requestLogger } from '../middleware/requestLog.js';

/** 签发令牌并组装响应体；密码等敏感字段不会出现在响应中 */
async function issueSession(
  user: UserRecord,
  sessions: SessionStore,
): Promise<{ token: string; user: { id: number; username: string } }> {
  return {
    token: await sessions.create(user.id),
    user: { id: user.id, username: user.username },
  };
}

/** 账号接口：注册、登录公开，登出与登录态查询需要携带令牌 */
export function createAuthRouter({
  users,
  sessions,
}: Pick<AppDependencies, 'users' | 'sessions'>): Router {
  const router = Router();
  const requireAuth = createRequireAuth(sessions);

  router.post('/register', async (req: Request, res: Response) => {
    const log = requestLogger(res);
    const parsed = parseCredentials(req.body);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }
    const user = await users.register(parsed.value.username, parsed.value.password);
    if (!user) {
      log.warn('注册被拒绝：用户名已存在', { username: parsed.value.username });
      // 用户名冲突归入“参数非法”：backend-design 第 3 章只约定 400/401/404/500
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '该用户名已被注册' });
      return;
    }
    // 注册成功即视为登录，省去一次重复输入
    log.info('注册成功', { userId: user.id, username: user.username });
    res.status(HTTP_STATUS.CREATED).json(await issueSession(user, sessions));
  });

  router.post('/login', async (req: Request, res: Response) => {
    const log = requestLogger(res);
    const parsed = parseCredentials(req.body);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }
    const user = await users.authenticate(parsed.value.username, parsed.value.password);
    // 用户不存在与密码错误使用同一提示，避免暴露账号是否已注册
    if (!user) {
      // 登录失败要留痕，便于识别异常尝试；密码本身不写入日志
      log.warn('登录失败：用户名或密码错误', { username: parsed.value.username });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: '用户名或密码错误' });
      return;
    }
    log.info('登录成功', { userId: user.id, username: user.username });
    res.json(await issueSession(user, sessions));
  });

  router.post('/logout', requireAuth, async (_req: Request, res: Response) => {
    await sessions.remove(currentToken(res));
    requestLogger(res).info('已登出', { userId: currentUserId(res) });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  /** 桌面端启动时用本地令牌换取当前用户信息，令牌失效则返回 401 */
  router.get('/me', requireAuth, async (_req: Request, res: Response) => {
    const user = await users.findById(currentUserId(res));
    if (!user) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.SESSION_EXPIRED });
      return;
    }
    res.json({ id: user.id, username: user.username });
  });

  return router;
}
