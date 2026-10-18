import type { AppDependencies } from '../../configuration/dependencies.js';
import { Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { currentUserId } from '../../middleware/auth.js';
import {
  getOwnConversation,
  listOwnConversations,
  removeOwnConversation,
} from '../../services/conversation/conversations.js';

/** 会话管理接口：全部按当前登录用户隔离 */
export function createConversationRouter({
  conversations,
}: Pick<AppDependencies, 'conversations'>): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json(await listOwnConversations(conversations, currentUserId(res)));
  });

  router.get('/:id', async (req, res) => {
    const conversation = await getOwnConversation(conversations, currentUserId(res), req.params.id);
    if (!conversation) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.CONVERSATION_NOT_FOUND });
      return;
    }
    res.json(conversation);
  });

  router.delete('/:id', async (req, res) => {
    if (!(await removeOwnConversation(conversations, currentUserId(res), req.params.id))) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.CONVERSATION_NOT_FOUND });
      return;
    }
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  return router;
}
