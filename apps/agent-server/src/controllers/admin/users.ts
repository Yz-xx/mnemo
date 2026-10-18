import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { isSuperAdmin } from '../../infrastructure/auth/actor.js';
import { parseCredentials } from '../../infrastructure/auth/credentials.js';
import { currentAdmin } from '../../middleware/auth.js';
import { requestLogger } from '../../middleware/requestLog.js';
import {
  listUsers,
  removeUser,
  removeUsers,
  updateUser,
  updateUsersStatus,
} from '../../services/admin/adminUsers.js';
import { createAccount } from '../../services/auth.js';
import { parseNumberIds } from '../../utils/batchIds.js';
import { parsePaging } from '../../utils/pagination.js';
import { assignableRoles, parseRole, parseStatus, respondIfFailed, toUserId } from './userInput.js';

/**
 * 管理端用户管理：列表、新建、变更角色/状态、删除与批量操作。
 * 挂在 /api/admin/users，模块内部只写相对路径；鉴权由 controllers/index.ts 统一挂 requireAdmin。
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
    const query = { keyword, page, pageSize };
    const { items, total } = await listUsers(users, query, scope);
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
    const user = await createAccount(users, parsed.value.username, parsed.value.password, role);
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
