import type { AuthUser } from './auth.js';

/** 管理端用户列表项：在登录态四个字段之上多一个创建时间，供列表展示 */
export interface AdminUser extends AuthUser {
  createdAt: string;
}

/** 账号汇总：总数与活跃/停用/管理员三项计数 */
export interface UserStats {
  total: number;
  active: number;
  banned: number;
  admins: number;
}
