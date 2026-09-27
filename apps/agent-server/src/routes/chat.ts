import { Router } from 'express';
import type { Request, Response } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { currentUserId } from '../auth/middleware.js';
import type { AppDependencies } from '../dependencies.js';
import { ERROR_MESSAGE } from '../messages.js';
import { requestLogger } from '../middleware/requestLog.js';
import { streamChatReply } from '../services/chatStream.js';

/** 本轮对话需要的依赖：只取用到的两项，便于单独编排与测试 */
type ChatDependencies = Pick<AppDependencies, 'agent' | 'conversations'>;

/** 对话接口：校验入参后交由 streamChatReply 编排整轮对话 */
export function createChatRouter(deps: ChatDependencies): Router {
  const router = Router();

  router.post('/', (req, res) => handleChatMessage(deps, req, res));

  return router;
}

/** 单轮对话入口：只做入参校验与会话归属校验，编排交给服务层 */
export async function handleChatMessage(
  { agent, conversations }: ChatDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  const userId = currentUserId(res);
  const body = req.body as { conversationId?: string; message?: string };
  const content = typeof body.message === 'string' ? body.message.trim() : '';
  if (!content) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '消息内容不能为空' });
    return;
  }
  // 指定了不存在（或不属于当前用户）的会话时直接报错，避免静默新建导致混淆
  if (body.conversationId && !(await conversations.get(userId, body.conversationId))) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.CONVERSATION_NOT_FOUND });
    return;
  }

  await streamChatReply({
    res,
    agent,
    conversations,
    logger: requestLogger(res),
    userId,
    conversationId: body.conversationId,
    content,
  });
}
