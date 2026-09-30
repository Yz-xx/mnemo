import type { AdminActor } from '../../auth/actor.js';
import type { UserRole, UserStatus } from '../../auth/userStore/index.js';
import type { AppDependencies } from '../../configuration/dependencies.js';
import type { MutationOutcome } from '../../services/adminUsers.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { isSuperAdmin } from '../../auth/actor.js';
import { parseCredentials } from '../../auth/credentials.js';
import { currentAdmin } from '../../auth/middleware.js';
import { ADMIN_ROLES } from '../../auth/userStore/index.js';
import { ERROR_MESSAGE } from '../../configuration/messages.js';
import { requestLogger } from '../../middleware/requestLog.js';
import {
  removeUser,
  removeUsers,
  updateUser,
  updateUsersStatus,
} from '../../services/adminUsers.js';
import { parsePaging } from '../pagination.js';
import { parseNumberIds } from './batchIds.js';

/** 路径参数里的用户 ID：非正整数视为参数非法 */
function toUserId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** 调用者可授予的角色：超管能建后台账号，普通管理员只能建客户端账号（见 docs/adr/0006） */
function assignableRoles(actor: AdminActor): UserRole[] {
  return isSuperAdmin(actor) ? [...ADMIN_ROLES, 'user'] : ['user'];
}

/**
 * 解析角色并顺带卡住可授予范围：普通管理员传 'admin' 与传一个不存在的角色同样返回 null，
 * 回同样的「取值非法」，不额外暴露权限边界。
 */
function parseRole(value: unknown, allowed: readonly UserRole[]): UserRole | null {
  const roles: readonly string[] = allowed;
  return typeof value === 'string' && roles.includes(value) ? (value as UserRole) : null;
}

function parseStatus(value: unknown): UserStatus | null {
  return value === 'active' || value === 'banned' ? value : null;
}

/**
 * 失败态结果直接写出响应并返回 true，调用方据此提前返回；
 * 成功态返回 false，由调用方决定是 200 还是 204。类型谓词的写法让调用方在提前返回后
 * 自动收窄到成功分支，不必再补一次 status 判断。
 * 批量接口的「不存在」是整批语境，调用处可覆盖文案。
 */
function respondIfFailed<T>(
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

/**
 * 管理端用户管理：列表、新建、变更角色/状态、删除与批量操作。
 * 挂在 /api/admin/users，模块内部只写相对路径；鉴权由 routes/index.ts 统一挂 requireAdmin。
 */
export function createAdminUsersRouter({
  users,
  sessions,
  conversations,
  files,
  passwordCipher,
}: Pick<
  AppDependencies,
  'users' | 'sessions' | 'conversations' | 'files' | 'passwordCipher'
>): Router {
  const router = Router();

  /** 用户列表：按用户名包含匹配 + 分页；普通管理员的列表里不出现后台账号 */
  router.get('/', async (req: Request, res: Response) => {
    const { page, pageSize } = parsePaging(req.query);
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    // 可见性也是权限：后台账号不进普通管理员的列表，否则会诱导操作并泄露后台账号数量
    const scope = isSuperAdmin(currentAdmin(res)) ? 'all' : 'client';
    const { items, total } = await users.list({ keyword, page, pageSize }, scope);
    res.json({ items, total, page, pageSize });
  });

  /** 新建用户：角色可选，缺省为普通用户；后台账号只有超管能建 */
  router.post('/', async (req: Request, res: Response) => {
    const parsed = parseCredentials(req.body, passwordCipher);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }
    const { role: rawRole } = (req.body ?? {}) as { role?: unknown };
    const allowed = assignableRoles(currentAdmin(res));
    const role = rawRole === undefined ? 'user' : parseRole(rawRole, allowed);
    if (role === null) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '角色取值非法' });
      return;
    }
    const user = await users.register(parsed.value.username, parsed.value.password, role);
    if (!user) {
      // 用户名冲突归入“参数非法”（backend-design 第 3 章）
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: ERROR_MESSAGE.USERNAME_TAKEN });
      return;
    }
    requestLogger(res).info('管理员新建用户', {
      userId: user.id,
      role: user.role,
      operator: currentAdmin(res).userId,
    });
    res.status(HTTP_STATUS.CREATED).json(user);
  });

  /** 批量停用 / 启用：自锁与管理员名额按整批判定，任一项不满足则整批不执行 */
  router.post('/batch-status', async (req: Request, res: Response) => {
    const { ids: rawIds, status: rawStatus } = (req.body ?? {}) as {
      ids?: unknown;
      status?: unknown;
    };
    const ids = parseNumberIds(rawIds);
    if (!ids) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: ERROR_MESSAGE.BATCH_IDS_NUMBER });
      return;
    }
    const status = parseStatus(rawStatus);
    if (status === null) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '状态取值非法' });
      return;
    }

    const result = await updateUsersStatus(
      { users, sessions, conversations, files },
      ids,
      status,
      currentAdmin(res),
    );
    if (respondIfFailed(res, result, '所选用户已不存在，请刷新后重试')) return;

    requestLogger(res).info('管理员批量变更用户状态', {
      count: result.value,
      status,
      operator: currentAdmin(res).userId,
    });
    res.json({ updated: result.value });
  });

  /** 批量删除用户：其会话、对话与上传文件一并清理，任一目标不可删则整批不执行 */
  router.post('/batch-delete', async (req: Request, res: Response) => {
    const ids = parseNumberIds(((req.body ?? {}) as { ids?: unknown }).ids);
    if (!ids) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: ERROR_MESSAGE.BATCH_IDS_NUMBER });
      return;
    }

    const result = await removeUsers(
      { users, sessions, conversations, files },
      ids,
      currentAdmin(res),
    );
    if (respondIfFailed(res, result, '所选用户已不存在，请刷新后重试')) return;

    requestLogger(res).info('管理员批量删除用户', {
      count: ids.length,
      operator: currentAdmin(res).userId,
    });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  /** 变更角色或状态：自锁规则由服务层判定 */
  router.patch('/:id', async (req: Request, res: Response) => {
    const id = toUserId(req.params.id);
    if (id === null) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '用户 ID 非法' });
      return;
    }
    const { role: rawRole, status: rawStatus } = (req.body ?? {}) as {
      role?: unknown;
      status?: unknown;
    };
    // 变更同样受可授予范围限制：普通管理员改不出后台账号
    const allowed = assignableRoles(currentAdmin(res));
    const role = rawRole === undefined ? undefined : parseRole(rawRole, allowed);
    const status = rawStatus === undefined ? undefined : parseStatus(rawStatus);
    if (role === null || status === null) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '角色或状态取值非法' });
      return;
    }
    if (role === undefined && status === undefined) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '没有需要修改的字段' });
      return;
    }

    const result = await updateUser(
      { users, sessions, conversations, files },
      id,
      { role, status },
      currentAdmin(res),
    );
    if (respondIfFailed(res, result)) return;

    requestLogger(res).info('管理员变更用户', {
      userId: id,
      role,
      status,
      operator: currentAdmin(res).userId,
    });
    res.json(result.value);
  });

  /** 删除用户：其会话、对话与上传文件一并清理 */
  router.delete('/:id', async (req: Request, res: Response) => {
    const id = toUserId(req.params.id);
    if (id === null) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '用户 ID 非法' });
      return;
    }

    const result = await removeUser(
      { users, sessions, conversations, files },
      id,
      currentAdmin(res),
    );
    if (respondIfFailed(res, result)) return;

    requestLogger(res).info('管理员删除用户', { userId: id, operator: currentAdmin(res).userId });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  return router;
}
