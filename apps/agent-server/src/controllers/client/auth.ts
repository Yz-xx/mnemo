import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { parseCredentials } from '../../infrastructure/auth/credentials.js';
import { toSessionUser } from '../../infrastructure/auth/sessionUser.js';
import { createRequireAuth, currentToken, currentUserId } from '../../middleware/auth.js';
import { requestLogger } from '../../middleware/requestLog.js';
import { findUser, logout, registerClientAccount } from '../../services/auth.js';
import { createLoginRoute } from '../loginRoute.js';

/**
 * 客户端账号接口：注册与登录公开，登出与登录态查询需要携带令牌。
 * 端由路径承载——后台登录在 controllers/admin/auth.ts，本入口只接受客户端账号（见 docs/adr/0006），
 * 于是「同一账号在两端互相顶掉」从根上不再可能。
 */
export function createAuthRouter({
  users,
  sessions,
  passwordCipher,
}: Pick<AppDependencies, 'users' | 'sessions' | 'passwordCipher'>): Router {
  const router = Router();
  const requireAuth = createRequireAuth(sessions);

  // 登录流程本身与后台共用，差别只在端与措辞（见 controllers/loginRoute.ts）
  router.use(createLoginRoute({ users, sessions, passwordCipher }, 'client'));

  /** 口令传输公钥：客户端在登录/注册前取回，用它加密密码字段后再提交（两端共用同一份） */
  router.get('/public-key', (_req: Request, res: Response) => {
    res.json({ publicKey: passwordCipher.publicKey() });
  });

  router.post('/register', async (req: Request, res: Response) => {
    const log = requestLogger(res);
    const parsed = parseCredentials(req.body, passwordCipher);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }
    // 角色写死为客户端账号：后台账号只能由超管在用户管理里创建，注册不产出后台权限
    const registered = await registerClientAccount(
      { users, sessions },
      parsed.value.username,
      parsed.value.password,
    );
    if (registered.status === 'taken') {
      log.warn('注册被拒绝：用户名已存在', { username: parsed.value.username });
      // 用户名冲突归入“参数非法”：backend-design 第 3 章只约定 400/401/404/500
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: ERROR_MESSAGE.USERNAME_TAKEN });
      return;
    }
    // 注册成功即视为登录，省去一次重复输入
    log.info('注册成功', {
      userId: registered.user.id,
      username: registered.user.username,
      role: registered.user.role,
    });
    res.status(HTTP_STATUS.CREATED).json(registered.session);
  });

  router.post('/logout', requireAuth, async (_req: Request, res: Response) => {
    await logout(sessions, currentToken(res));
    requestLogger(res).info('已登出', { userId: currentUserId(res) });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  /** 客户端启动时用本地令牌换取当前用户信息，令牌失效则返回 401 */
  router.get('/me', requireAuth, async (_req: Request, res: Response) => {
    const user = await findUser(users, currentUserId(res));
    if (!user) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.SESSION_EXPIRED });
      return;
    }
    res.json(toSessionUser(user));
  });

  return router;
}
