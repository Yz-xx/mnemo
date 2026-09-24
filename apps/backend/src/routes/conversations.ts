import { Router } from 'express';
import type { ConversationStore } from '../conversation/store.js';

/** 会话管理接口 */
export function createConversationRouter(conversations: ConversationStore): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(conversations.list());
  });

  router.get('/:id', (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ message: '会话不存在' });
      return;
    }
    res.json(conversation);
  });

  router.delete('/:id', (req, res) => {
    if (!conversations.remove(req.params.id)) {
      res.status(404).json({ message: '会话不存在' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
