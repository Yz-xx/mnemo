/**
 * 角色：super_admin 与 admin 同属后台侧，仅在用户管理模块权限不同；
 * user 只能登录客户端。账号与端绑定，见 docs/adr/0006。
 */
export type UserRole = 'super_admin' | 'admin' | 'user';

/** 后台侧角色：管理端鉴权与用户管理分支共用同一份判据，避免散落成多处 || */
export const ADMIN_ROLES: readonly UserRole[] = ['super_admin', 'admin'];

/** 是否为后台侧角色：端隔离（能否登录后台）与权限分级都以此判定 */
export function isAdminRole(role: UserRole): boolean {
  return ADMIN_ROLES.includes(role);
}

/** 超管自举结果：created 已创建；skipped 库中已有后台账号；username-taken 用户名被客户端账号占用 */
export type SuperAdminBootstrap = 'created' | 'skipped' | 'username-taken';

/** 账号状态：banned 表示禁止登录，历史数据仍保留以便审计 */
export type UserStatus = 'active' | 'banned';

/** 对外返回的用户信息：不包含密码字段 */
export interface UserRecord {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

/** 管理端列表查询条件：keyword 按用户名包含匹配，分页参数已在路由层收敛 */
export interface UserQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 列表可见范围：超管看得到全部账号，普通管理员只看得到客户端账号 */
export type UserListScope = 'all' | 'client';

/** 用户分页结果：total 为满足条件的总数，供前端计算总页数 */
export interface UserPage {
  items: UserRecord[];
  total: number;
}

/** 账号汇总：一条聚合查询取回四个计数，避免总览为每项各发一次请求 */
export interface UserStats {
  total: number;
  active: number;
  banned: number;
  admins: number;
}

/** 管理员可变更的字段：未传的字段保持原值 */
export interface UserPatch {
  role?: UserRole;
  status?: UserStatus;
}
