import type { AdminActor } from '../auth/actor.js';
import type { SessionStore } from '../auth/sessionStore.js';
import type { UserPatch, UserRecord, UserStatus, UserStore } from '../auth/userStore/index.js';
import type { ConversationStore } from '../conversation/store/index.js';
import type { FileStore } from '../files/store.js';
import { isSuperAdmin } from '../auth/actor.js';
import { isAdminRole } from '../auth/userStore/index.js';
import { ERROR_MESSAGE } from '../configuration/messages.js';

/**
 * 用户变更结果：把「目标不存在」与「业务规则拒绝」分开表达，
 * 路由据此映射 404 与 400，不必各自复述一遍判定逻辑。
 */
export type MutationOutcome<T> =
  { status: 'ok'; value: T } | { status: 'not-found' } | { status: 'rejected'; message: string };

/**
 * 变更用户所需的依赖：只声明本模块真正用到的能力，
 * 测试构造四个小替身即可，不必拼出完整的 Store。
 */
export interface AdminUserDeps {
  users: Pick<UserStore, 'findById' | 'update' | 'remove' | 'countActiveAdmins'>;
  sessions: Pick<SessionStore, 'removeAllByUser'>;
  conversations: Pick<ConversationStore, 'removeAllByUser'>;
  files: Pick<FileStore, 'removeAllByUser'>;
}

/**
 * 目标账号是否超出调用者的管辖范围：普通管理员只看得见也管得着客户端账号。
 * 越界一律按「账号不存在」处理——列表里本就不显示后台账号，单条请求也不该让它暴露存在性。
 */
function isOutOfScope(target: UserRecord, actor: AdminActor): boolean {
  return !isSuperAdmin(actor) && isAdminRole(target.role);
}

/**
 * 目标是否是库里最后一名「可登录」的后台账号。
 * 只看后台侧角色且 status 为 active 的账号：被停用的账号进不了后台，不能顶这个名额，
 * 否则把所有后台账号逐个停用就能让后台彻底无人可进。
 */
async function isLastActiveAdmin(deps: AdminUserDeps, target: UserRecord): Promise<boolean> {
  if (!isAdminRole(target.role) || target.status !== 'active') return false;
  return (await deps.users.countActiveAdmins()) <= 1;
}

/**
 * 批量加载目标用户：任一 id 查不到就整体失败。
 * 批量操作采「整体拒绝」语义，不静默跳过已消失的项——否则用户以为全删了，实际漏了几条。
 * 超出调用者管辖范围的账号同样算「查不到」，与列表看不到它保持一致。
 */
async function loadTargets(
  deps: AdminUserDeps,
  ids: number[],
  actor: AdminActor,
): Promise<UserRecord[] | null> {
  const targets: UserRecord[] = [];
  for (const id of ids) {
    const target = await deps.users.findById(id);
    if (!target || isOutOfScope(target, actor)) return null;
    targets.push(target);
  }
  return targets;
}

/**
 * 这批目标会消耗掉多少个「可登录后台账号」名额：只有当前是 active 的后台账号占名额。
 * 必须按整批一次算——逐个判定时「一次停用两名管理员」会各自看到还剩别人可登录而误放行。
 */
function consumedAdminSlots(targets: UserRecord[]): number {
  return targets.filter((target) => isAdminRole(target.role) && target.status === 'active').length;
}

/**
 * 本批处理是否会让可登录管理员归零。
 * 不占名额的批次（全是普通用户）一律放行，与单条 isLastActiveAdmin 的语义一致——
 * 否则库里一名可登录管理员都没有时，连停用或删除普通用户都会被整体拒绝。
 */
async function wouldEmptyAdmins(deps: AdminUserDeps, targets: UserRecord[]): Promise<boolean> {
  const slots = consumedAdminSlots(targets);
  if (slots === 0) return false;
  return slots >= (await deps.users.countActiveAdmins());
}

/** 目标里是否包含当前登录账号：超级令牌入口不对应具体账号，此时恒为 false */
function touchesSelf(ids: number[], actor: AdminActor): boolean {
  return actor.userId !== null && ids.includes(actor.userId);
}

/** 清理账号的全部从属数据后再删账号（消息由外键级联） */
async function purgeUser(deps: AdminUserDeps, targetId: number): Promise<void> {
  // 本轮不引入跨 Store 事务：中途失败时账号仍在，重试即可收敛（已清理的部分重复删除不会报错）
  await deps.sessions.removeAllByUser(targetId);
  await deps.conversations.removeAllByUser(targetId);
  await deps.files.removeAllByUser(targetId);
  await deps.users.remove(targetId);
}

/**
 * 变更用户角色或状态。
 * 两条自锁规则收在这里：管理员不能停用或降级自己，也不能让可登录的管理员归零——
 * 否则后台立刻无人可进（超级令牌是应急通道，不该沦为日常入口）。
 */
export async function updateUser(
  deps: AdminUserDeps,
  targetId: number,
  patch: UserPatch,
  actor: AdminActor,
): Promise<MutationOutcome<UserRecord>> {
  const target = await deps.users.findById(targetId);
  if (!target || isOutOfScope(target, actor)) return { status: 'not-found' };

  const locksSelfOut =
    actor.userId === targetId && (patch.role === 'user' || patch.status === 'banned');
  if (locksSelfOut) return { status: 'rejected', message: ERROR_MESSAGE.SELF_DEACTIVATE };

  // 变更后仍是可登录后台账号就不消耗名额；否则要确认库里还有别人能进后台
  const nextRole = patch.role ?? target.role;
  const nextStatus = patch.status ?? target.status;
  const keepsAdminAccess = isAdminRole(nextRole) && nextStatus === 'active';
  if (!keepsAdminAccess && (await isLastActiveAdmin(deps, target))) {
    return { status: 'rejected', message: ERROR_MESSAGE.LAST_ADMIN };
  }

  const user = await deps.users.update(targetId, patch);
  return user ? { status: 'ok', value: user } : { status: 'not-found' };
}

/** 删除用户：连同其登录会话、对话与上传文件一并清理 */
export async function removeUser(
  deps: AdminUserDeps,
  targetId: number,
  actor: AdminActor,
): Promise<MutationOutcome<void>> {
  const target = await deps.users.findById(targetId);
  if (!target || isOutOfScope(target, actor)) return { status: 'not-found' };
  if (actor.userId === targetId) return { status: 'rejected', message: ERROR_MESSAGE.SELF_DELETE };
  if (await isLastActiveAdmin(deps, target)) {
    return { status: 'rejected', message: ERROR_MESSAGE.LAST_ADMIN };
  }

  await purgeUser(deps, targetId);
  return { status: 'ok', value: undefined };
}

/**
 * 批量停用或启用。
 * 规则与单条一致，但按整批判定：任一项不满足则整批不执行并提示原因，不做部分生效。
 * 返回本批处理的账号数（含本就在目标状态的条目），路由据此回执。
 */
export async function updateUsersStatus(
  deps: AdminUserDeps,
  ids: number[],
  status: UserStatus,
  actor: AdminActor,
): Promise<MutationOutcome<number>> {
  const targets = await loadTargets(deps, ids, actor);
  if (!targets) return { status: 'not-found' };

  // 启用不消耗名额，只有停用才需要过这两道判定
  if (status === 'banned') {
    if (touchesSelf(ids, actor)) {
      return { status: 'rejected', message: ERROR_MESSAGE.SELF_DEACTIVATE };
    }
    if (await wouldEmptyAdmins(deps, targets)) {
      return { status: 'rejected', message: ERROR_MESSAGE.LAST_ADMIN };
    }
  }

  for (const target of targets) await deps.users.update(target.id, { status });
  return { status: 'ok', value: targets.length };
}

/** 批量删除用户：规则同单条删除，同样整批判定 */
export async function removeUsers(
  deps: AdminUserDeps,
  ids: number[],
  actor: AdminActor,
): Promise<MutationOutcome<void>> {
  const targets = await loadTargets(deps, ids, actor);
  if (!targets) return { status: 'not-found' };
  if (touchesSelf(ids, actor)) return { status: 'rejected', message: ERROR_MESSAGE.SELF_DELETE };
  if (await wouldEmptyAdmins(deps, targets)) {
    return { status: 'rejected', message: ERROR_MESSAGE.LAST_ADMIN };
  }

  for (const target of targets) await purgeUser(deps, target.id);
  return { status: 'ok', value: undefined };
}
