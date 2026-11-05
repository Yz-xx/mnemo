import type { AppDependencies } from '../../configuration/dependencies.js';
import { Router } from 'express';
import { createLoginRoute } from '../loginRoute.js';

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
  return createLoginRoute({ users, sessions, passwordCipher }, 'admin');
}
