import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { currentAdmin } from '../../auth/middleware.js';
import { ERROR_MESSAGE } from '../../configuration/messages.js';
import { requestLogger } from '../../middleware/requestLog.js';
import { parsePaging } from '../pagination.js';
import { parseStringIds } from './batchIds.js';

/** 路径参数：Express 5 的值类型为 string | string[]，路径参数实际只有单值，这里收窄 */
function pathParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 管理端会话：以管理视角查看与清理全部用户的会话。
 * 挂在 /api/admin/conversations，模块内部只写相对路径；鉴权由 routes/index.ts 统一挂 requireAdmin。
 */
export function createAdminConversationsRouter({
  conversations,
  users,
}: Pick<AppDependencies, 'conversations' | 'users'>): Router {
  const router = Router();

  /** 会话列表：按标题包含匹配 + 分页，归属账号名一次批量还原 */
  router.get('/', async (req: Request, res: Response) => {
    const { page, pageSize } = parsePaging(req.query);
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const { items, total } = await conversations.listAll({ keyword, page, pageSize });
    const names = await users.findNamesByIds(items.map((item) => item.userId));

    res.json({
      items: items.map((item) => ({ ...item, ownerName: names.get(item.userId) ?? null })),
      total,
      page,
      pageSize,
    });
  });

  /** 批量删除会话：逐条清理，已不存在的视为已完成（幂等），消息由外键级联 */
  router.post('/batch-delete', async (req: Request, res: Response) => {
    const ids = parseStringIds(((req.body ?? {}) as { ids?: unknown }).ids);
    if (!ids) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: ERROR_MESSAGE.BATCH_IDS_STRING });
      return;
    }

    for (const id of ids) await conversations.removeById(id);
    requestLogger(res).info('管理端批量删除会话', {
      count: ids.length,
      operator: currentAdmin(res).userId,
    });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  /** 会话详情：含全部消息，供后台核查具体对话内容 */
  router.get('/:id', async (req: Request, res: Response) => {
    const conversation = await conversations.find(pathParam(req.params.id));
    if (!conversation) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.CONVERSATION_NOT_FOUND });
      return;
    }
    const names = await users.findNamesByIds([conversation.userId]);
    res.json({ ...conversation, ownerName: names.get(conversation.userId) ?? null });
  });

  /** 删除会话：消息由外键级联清理，不可逆故留一条业务日志 */
  router.delete('/:id', async (req: Request, res: Response) => {
    const id = pathParam(req.params.id);
    const removed = await conversations.removeById(id);
    if (!removed) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.CONVERSATION_NOT_FOUND });
      return;
    }
    requestLogger(res).info('管理端删除会话', {
      conversationId: id,
      operator: currentAdmin(res).userId,
    });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  return router;
}
