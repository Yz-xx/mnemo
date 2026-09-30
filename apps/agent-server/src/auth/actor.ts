import type { UserRole } from './userStore/index.js';

/**
 * 管理端身份：超级令牌不对应具体账号，故 userId 与 role 均可空。
 * 独立成模块是因为这组判据不止 HTTP 层要用——服务层判定管辖范围时也要它，
 * 留在 middleware 里会迫使 services 反向 import 出 Express RequestHandler 的模块。
 */
export interface AdminActor {
  /** 经登录会话进入时为账号 ID；经超级令牌进入时为 null */
  userId: number | null;
  /** 是否经运维超级令牌（x-admin-token）进入 */
  superToken: boolean;
  /** 调用者角色；经超级令牌进入时为 null，此时权限等价超管 */
  role: UserRole | null;
}

/**
 * 调用者是否拥有超管权限：超管账号或运维超级令牌。
 * 只有用户管理模块需要区分（见 docs/adr/0006），其余模块要求「是后台角色」即可。
 */
export function isSuperAdmin(actor: AdminActor): boolean {
  return actor.superToken || actor.role === 'super_admin';
}
