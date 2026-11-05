/** 角色：super_admin 与 admin 可登录管理后台，user 仅能使用桌面端 */
export type UserRole = 'super_admin' | 'admin' | 'user';

/** 后台侧角色：能登录管理后台的两类账号，与后端 auth/userStore 的 ADMIN_ROLES 同口径 */
export const ADMIN_ROLES: readonly UserRole[] = ['super_admin', 'admin'];

/** 角色下拉项：取值与中文标签一并给出，用户管理页与新建弹窗共用同一份形状 */
export interface RoleOption {
  value: UserRole;
  label: string;
}

/** 账号状态：banned 禁止登录 */
export type UserStatus = 'active' | 'banned';

/** 当前登录用户：登录响应与 /api/auth/me 返回的结构 */
export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
}

/** 登录响应：token 与用户信息 */
export interface AuthSession {
  token: string;
  user: AuthUser;
}
