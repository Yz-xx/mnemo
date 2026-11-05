import type { AppDependencies } from '../../configuration/dependencies.js';
import { Router } from 'express';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { currentUserId } from '../../middleware/auth.js';
import {
  getOwnConversation,
  listOwnConversations,
  parseConversationTitle,
  removeOwnConversation,
  renameOwnConversation,
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

  /** 重命名会话：标题校验失败 400；不属于当前用户按不存在 404 */
  router.patch('/:id', async (req, res) => {
    const parsed = parseConversationTitle(req.body);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }
    const renamed = await renameOwnConversation(
      conversations,
      currentUserId(res),
      req.params.id,
      parsed.title,
    );
    if (!renamed) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.CONVERSATION_NOT_FOUND });
      return;
    }
    res.json({ id: req.params.id, title: parsed.title });
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
