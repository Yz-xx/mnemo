import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { parseCredentials } from '../../auth/credentials.js';
import { issueSession } from '../../auth/sessionUser.js';
import { isAdminRole } from '../../auth/userStore/index.js';
import { ERROR_MESSAGE } from '../../configuration/messages.js';
import { requestLogger } from '../../middleware/requestLog.js';

/**
 * 后台登录：与客户端登录拆成两个入口，端由路径承载，不让调用方传字段自证身份。
 * 校验口径与客户端一致，只多一道「必须是后台侧角色」的判定（见 docs/adr/0006）。
 *
 * 口令加密公钥仍走 /api/auth/public-key：那一枚密钥对两端共用，本入口无需再发一份。
 */
export function createAdminAuthRouter({
  users,
  sessions,
  passwordCipher,
}: Pick<AppDependencies, 'users' | 'sessions' | 'passwordCipher'>): Router {
  const router = Router();

  router.post('/login', async (req: Request, res: Response) => {
    const log = requestLogger(res);
    const parsed = parseCredentials(req.body, passwordCipher);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }
    const user = await users.authenticate(parsed.value.username, parsed.value.password);
    // 用户不存在与密码错误使用同一提示，避免暴露账号是否已注册
    if (!user) {
      log.warn('后台登录失败：用户名或密码错误', { username: parsed.value.username });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.BAD_CREDENTIALS });
      return;
    }
    // 口令已通过才提示端不匹配：此时对方已证明自己持有该账号，含糊会被误读成密码错误
    if (!isAdminRole(user.role)) {
      log.warn('后台登录被拒绝：账号不属于后台', { userId: user.id, username: user.username });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.ADMIN_ONLY });
      return;
    }
    if (user.status === 'banned') {
      log.warn('后台登录被拒绝：账号已停用', { userId: user.id, username: user.username });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.ACCOUNT_BANNED });
      return;
    }
    log.info('后台登录成功', { userId: user.id, username: user.username, role: user.role });
    res.json(await issueSession(user, sessions));
  });

  return router;
}
