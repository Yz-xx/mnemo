import type { SessionStore } from './sessionStore.js';
import type { UserRecord, UserRole, UserStatus } from './userStore/index.js';

/**
 * 登录响应的组装：客户端与后台两个登录入口共用，避免各自写一份后响应体悄悄漂移。
 * 端隔离只体现在「接受哪些角色」上（见 docs/adr/0006），响应结构与签发方式完全相同。
 */

/** 登录响应里的用户信息：只吐这四个字段，密码等敏感内容不进响应体 */
export interface SessionUser {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
}

export function toSessionUser(user: UserRecord): SessionUser {
  return { id: user.id, username: user.username, role: user.role, status: user.status };
}

/** 签发令牌并组装响应体；单端登录语义（新会话清掉旧会话）由 SessionStore 保证 */
export async function issueSession(
  user: UserRecord,
  sessions: SessionStore,
): Promise<{ token: string; user: SessionUser }> {
  const token = await sessions.create(user.id);
  return { token, user: toSessionUser(user) };
}
