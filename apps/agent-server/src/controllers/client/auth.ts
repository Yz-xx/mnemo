import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { parseCredentials } from '../../infrastructure/auth/credentials.js';
import { toSessionUser } from '../../infrastructure/auth/sessionUser.js';
import { createRequireAuth, currentToken, currentUserId } from '../../middleware/auth.js';
import { requestLogger } from '../../middleware/requestLog.js';
import { findUser, login, logout, registerClientAccount } from '../../services/auth.js';

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

  router.post('/login', async (req: Request, res: Response) => {
    const log = requestLogger(res);
    const parsed = parseCredentials(req.body, passwordCipher);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }
    const outcome = await login(
      { users, sessions },
      parsed.value.username,
      parsed.value.password,
      'client',
    );
    // 用户不存在与密码错误使用同一提示，避免暴露账号是否已注册
    if (outcome.status === 'bad-credentials') {
      // 登录失败要留痕，便于识别异常尝试；密码本身不写入日志
      log.warn('登录失败：用户名或密码错误', { username: parsed.value.username });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.BAD_CREDENTIALS });
      return;
    }
    // 口令已通过才提示端不匹配：此时对方已证明自己持有该账号，含糊会被误读成密码错误
    if (outcome.status === 'wrong-side') {
      log.warn('登录被拒绝：账号不属于客户端', {
        userId: outcome.user.id,
        username: outcome.user.username,
      });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.CLIENT_ONLY });
      return;
    }
    // 停用账号与密码错误分开提示：被停用的人需要知道该找管理员，而不是反复试密码
    if (outcome.status === 'banned') {
      log.warn('登录被拒绝：账号已停用', {
        userId: outcome.user.id,
        username: outcome.user.username,
      });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.ACCOUNT_BANNED });
      return;
    }
    log.info('登录成功', {
      userId: outcome.user.id,
      username: outcome.user.username,
      role: outcome.user.role,
    });
    res.json(outcome.session);
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
