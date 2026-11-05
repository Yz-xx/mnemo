import type { AppDependencies } from '../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ERROR_MESSAGE } from '../common/messages.js';
import { parseCredentials } from '../infrastructure/auth/credentials.js';
import { requestLogger } from '../middleware/requestLog.js';
import { login } from '../services/auth.js';

/** 登录的端：端由路径承载，调用方不传字段自证身份（见 docs/adr/0006） */
export type LoginSide = 'admin' | 'client';

/**
 * 两个端只有措辞不同，校验流程完全一致，故措辞收在一张表里。
 * 端不匹配的提示在口令校验通过后才给出：此时对方已证明自己持有该账号，含糊会被误读成密码错误。
 */
const SIDE_COPY: Record<
  LoginSide,
  {
    failed: string;
    wrongSide: string;
    banned: string;
    success: string;
    wrongSideMessage: string;
  }
> = {
  admin: {
    failed: '后台登录失败：用户名或密码错误',
    wrongSide: '后台登录被拒绝：账号不属于后台',
    banned: '后台登录被拒绝：账号已停用',
    success: '后台登录成功',
    wrongSideMessage: ERROR_MESSAGE.ADMIN_ONLY,
  },
  client: {
    failed: '登录失败：用户名或密码错误',
    wrongSide: '登录被拒绝：账号不属于客户端',
    banned: '登录被拒绝：账号已停用',
    success: '登录成功',
    wrongSideMessage: ERROR_MESSAGE.CLIENT_ONLY,
  },
};

type LoginDeps = Pick<AppDependencies, 'users' | 'sessions' | 'passwordCipher'>;

/**
 * 登录路由：后台与客户端共用「解析凭证 → 校验 → 按结果分支」这一套流程，
 * 账号归属哪一端由 login 服务判定，本路由只把端带进去。
 */
export function createLoginRoute(
  { users, sessions, passwordCipher }: LoginDeps,
  side: LoginSide,
): Router {
  const router = Router();
  const copy = SIDE_COPY[side];

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
      side,
    );
    // 用户不存在与密码错误使用同一提示，避免暴露账号是否已注册
    if (outcome.status === 'bad-credentials') {
      log.warn(copy.failed, { username: parsed.value.username });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.BAD_CREDENTIALS });
      return;
    }
    if (outcome.status === 'wrong-side') {
      log.warn(copy.wrongSide, {
        userId: outcome.user.id,
        username: outcome.user.username,
      });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: copy.wrongSideMessage });
      return;
    }
    if (outcome.status === 'banned') {
      log.warn(copy.banned, {
        userId: outcome.user.id,
        username: outcome.user.username,
      });
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ message: ERROR_MESSAGE.ACCOUNT_BANNED });
      return;
    }
    log.info(copy.success, {
      userId: outcome.user.id,
      username: outcome.user.username,
      role: outcome.user.role,
    });
    res.json(outcome.session);
  });

  return router;
}
