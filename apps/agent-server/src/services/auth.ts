import type { UserRecord, UserRole } from '../entities/user.js';
import type { SessionUser } from '../infrastructure/auth/sessionUser.js';
import type { SessionStore } from '../mappers/session.js';
import type { UserStore } from '../mappers/user/store.js';
import { isAdminRole } from '../entities/user.js';
import { issueSession } from '../infrastructure/auth/sessionUser.js';

/**
 * 账号业务：注册、登录判定、登录态查询与登出。
 * 客户端与后台两个登录入口共用这里的判定链，只在「接受哪些角色」上分道——
 * 端隔离口径见 docs/adr/0006，两处各写一份迟早会漂移。
 */

/** 登录入口所属的端 */
export type LoginSide = 'client' | 'admin';

/**
 * 登录判定结果：把「凭据不对」「端不匹配」「账号已停用」分开表达，
 * 文案与状态码留给路由映射——两端提示本就不同（客户端 CLIENT_ONLY / 后台 ADMIN_ONLY）。
 */
export type LoginOutcome =
  | { status: 'ok'; user: UserRecord; session: { token: string; user: SessionUser } }
  | { status: 'bad-credentials' }
  | { status: 'wrong-side'; user: UserRecord }
  | { status: 'banned'; user: UserRecord };

/** 注册客户端账号的结果：用户名被占用时不去签发会话 */
export type RegisterOutcome =
  | { status: 'ok'; user: UserRecord; session: { token: string; user: SessionUser } }
  | { status: 'taken' };

/** 登录与注册所需的依赖 */
export interface AuthDeps {
  users: Pick<UserStore, 'register' | 'authenticate' | 'findById'>;
  sessions: SessionStore;
}

/** 建账号：角色由调用方给定，用户名冲突返回 null 由路由映射为参数非法 */
export function createAccount(
  users: Pick<UserStore, 'register'>,
  username: string,
  password: string,
  role: UserRole,
): Promise<UserRecord | null> {
  return users.register(username, password, role);
}

/** 注册客户端账号：角色写死为 user（后台账号只能由超管在用户管理里创建），注册成功即视为登录 */
export async function registerClientAccount(
  deps: AuthDeps,
  username: string,
  password: string,
): Promise<RegisterOutcome> {
  const user = await createAccount(deps.users, username, password, 'user');
  if (!user) return { status: 'taken' };
  return { status: 'ok', user, session: await issueSession(user, deps.sessions) };
}

/**
 * 登录判定：口令 → 端匹配 → 停用，顺序与两端原有实现一致。
 * 口令通过才判端：此时对方已证明持有该账号，含糊提示会被误读成密码错误。
 */
export async function login(
  deps: AuthDeps,
  username: string,
  password: string,
  side: LoginSide,
): Promise<LoginOutcome> {
  const user = await deps.users.authenticate(username, password);
  if (!user) return { status: 'bad-credentials' };
  // 客户端只收 user、后台只收后台侧角色，两个端的判据互为正反，收在一处
  const mismatched = side === 'client' ? isAdminRole(user.role) : !isAdminRole(user.role);
  if (mismatched) return { status: 'wrong-side', user };
  if (user.status === 'banned') return { status: 'banned', user };
  return { status: 'ok', user, session: await issueSession(user, deps.sessions) };
}

/** 按 ID 取账号：客户端换登录态用，查不到由路由映射为 401 */
export function findUser(
  users: Pick<UserStore, 'findById'>,
  userId: number,
): Promise<UserRecord | null> {
  return users.findById(userId);
}

/** 登出：清掉当前令牌对应的会话 */
export function logout(sessions: Pick<SessionStore, 'remove'>, token: string): Promise<void> {
  return sessions.remove(token);
}
