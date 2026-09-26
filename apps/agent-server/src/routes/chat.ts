import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppDependencies } from '../dependencies.js';
import { currentUserId } from '../auth/middleware.js';
import { requestLogger } from '../middleware/requestLog.js';
import { streamChatReply } from '../services/chatStream.js';

/** 对话接口：校验入参后交由 streamChatReply 以 SSE 流式返回回复 */
export function createChatRouter({ agent, conversations }: AppDependencies): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const userId = currentUserId(res);
    const body = req.body as { conversationId?: string; message?: string };
    const content = typeof body.message === 'string' ? body.message.trim() : '';
    if (!content) {
      res.status(400).json({ message: '消息内容不能为空' });
      return;
    }
    // 指定了不存在（或不属于当前用户）的会话时直接报错，避免静默新建导致混淆
    if (body.conversationId && !(await conversations.get(userId, body.conversationId))) {
      res.status(404).json({ message: '会话不存在' });
      return;
    }

    // 先落库用户消息，再把整轮回复交给流式服务编排
    const conversation = await conversations.append(userId, body.conversationId, 'user', content);
    await streamChatReply({
      res,
      agent,
      conversations,
      logger: requestLogger(res),
      userId,
      conversation,
    });
  });

  return router;
}
