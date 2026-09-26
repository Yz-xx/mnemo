import { Router } from 'express';
import { currentUserId } from '../auth/middleware.js';
import type { ConversationStore } from '../conversation/store.js';

/** 会话管理接口：全部按当前登录用户隔离 */
export function createConversationRouter(conversations: ConversationStore): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json(await conversations.list(currentUserId(res)));
  });

  router.get('/:id', async (req, res) => {
    const conversation = await conversations.get(currentUserId(res), req.params.id);
    if (!conversation) {
      res.status(404).json({ message: '会话不存在' });
      return;
    }
    res.json(conversation);
  });

  router.delete('/:id', async (req, res) => {
    if (!(await conversations.remove(currentUserId(res), req.params.id))) {
      res.status(404).json({ message: '会话不存在' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
