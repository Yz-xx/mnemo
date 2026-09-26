import { Router } from 'express';
import { HTTP_STATUS } from '@repo/shared';
import { currentUserId } from '../auth/middleware.js';
import type { AppDependencies } from '../dependencies.js';
import { ERROR_MESSAGE } from '../messages.js';

/** 会话管理接口：全部按当前登录用户隔离 */
export function createConversationRouter({
  conversations,
}: Pick<AppDependencies, 'conversations'>): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json(await conversations.list(currentUserId(res)));
  });

  router.get('/:id', async (req, res) => {
    const conversation = await conversations.get(currentUserId(res), req.params.id);
    if (!conversation) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.CONVERSATION_NOT_FOUND });
      return;
    }
    res.json(conversation);
  });

  router.delete('/:id', async (req, res) => {
    if (!(await conversations.remove(currentUserId(res), req.params.id))) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.CONVERSATION_NOT_FOUND });
      return;
    }
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  return router;
}
