import type { UserRole, UserStatus } from '../../entities/user.js';
import type { AdminActor } from '../../infrastructure/auth/actor.js';
import type { MutationOutcome } from '../../services/admin/adminUsers.js';
import type { Response } from 'express';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ADMIN_ROLES } from '../../entities/user.js';
import { isSuperAdmin } from '../../infrastructure/auth/actor.js';

/** 路径参数里的用户 ID：非正整数视为参数非法 */
export function toUserId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** 调用者可授予的角色：超管能建后台账号，普通管理员只能建客户端账号（见 docs/adr/0006） */
export function assignableRoles(actor: AdminActor): UserRole[] {
  return isSuperAdmin(actor) ? [...ADMIN_ROLES, 'user'] : ['user'];
}

/**
 * 解析角色并顺带卡住可授予范围：普通管理员传 'admin' 与传一个不存在的角色同样返回 null，
 * 回同样的「取值非法」，不额外暴露权限边界。
 */
export function parseRole(value: unknown, allowed: readonly UserRole[]): UserRole | null {
  const roles: readonly string[] = allowed;
  return typeof value === 'string' && roles.includes(value) ? (value as UserRole) : null;
}

export function parseStatus(value: unknown): UserStatus | null {
  return value === 'active' || value === 'banned' ? value : null;
}

/**
 * 失败态结果直接写出响应并返回 true，调用方据此提前返回；
 * 成功态返回 false，由调用方决定是 200 还是 204。类型谓词的写法让调用方在提前返回后
 * 自动收窄到成功分支，不必再补一次 status 判断。
 * 批量接口的「不存在」是整批语境，调用处可覆盖文案。
 */
export function respondIfFailed<T>(
  res: Response,
  result: MutationOutcome<T>,
  notFoundMessage = '用户不存在',
): result is { status: 'not-found' } | { status: 'rejected'; message: string } {
  if (result.status === 'not-found') {
    res.status(HTTP_STATUS.NOT_FOUND).json({ message: notFoundMessage });
    return true;
  }
  if (result.status === 'rejected') {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ message: result.message });
    return true;
  }
  return false;
}
