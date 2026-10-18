import type { UserStore } from '../../mappers/user/store.js';
import type { Logger } from '@repo/logger';

/**
 * 超管自举：仅当库中没有任何后台侧账号时创建一枚超管（已存在则原样跳过，不覆盖）。
 * 未配置凭据时告警而非静默跳过——否则新库部署完才发现没人能进管理后台（见 docs/adr/0006）。
 */
export async function bootstrapSuperAdmin(
  users: UserStore,
  credentials: { username: string; password: string },
  logger: Logger,
): Promise<void> {
  if (!credentials.username || !credentials.password) {
    logger.warn('未配置初始超管凭据，跳过自举；库中若无后台账号将进不去管理后台', {
      hint: '需设置 INITIAL_ADMIN_USERNAME 与 INITIAL_ADMIN_PASSWORD',
    });
    return;
  }
  const result = await users.ensureSuperAdmin(credentials.username, credentials.password);
  if (result === 'created') {
    logger.info('已创建初始超级管理员', { username: credentials.username });
  } else if (result === 'username-taken') {
    logger.error('超管自举失败：用户名已被客户端账号占用', { username: credentials.username });
  }
}
