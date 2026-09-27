import { Router } from 'express';
import type { Request, Response } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { currentUserId } from '../auth/middleware.js';
import type { AppDependencies } from '../configuration/dependencies.js';
import { ERROR_MESSAGE } from '../configuration/messages.js';
import { requestLogger } from '../middleware/requestLog.js';
import { streamChatReply } from '../services/chatStream.js';

/** 本轮对话需要的依赖：只取用到的三项，便于单独编排与测试 */
type ChatDependencies = Pick<AppDependencies, 'agent' | 'conversations' | 'files'>;

/** 对话接口：校验入参后交由 streamChatReply 编排整轮对话 */
export function createChatRouter(deps: ChatDependencies): Router {
  const router = Router();

  router.post('/', (req, res) => handleChatMessage(deps, req, res));

  return router;
}

/** 归整入参中的附件 ID：非数组视为没有附件，剔除空值与重复项，不让脏数据进入工具层的可读名单 */
function parseFileIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  return [...new Set(ids)];
}

/** 单轮对话入口：只做入参与会话、附件归属校验，编排交给服务层 */
export async function handleChatMessage(
  { agent, conversations, files }: ChatDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  const userId = currentUserId(res);
  const body = req.body as { conversationId?: string; message?: string; fileIds?: unknown };
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
  // 附件同样先验归属：有不存在的就报错，否则模型拿到空清单后会答成"没有附件"，让人以为是上传失败
  const fileIds = parseFileIds(body.fileIds);
  const storedFiles = fileIds.length > 0 ? await files.list(userId, fileIds) : [];
  if (fileIds.length > 0 && storedFiles.length !== fileIds.length) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ message: '附件不存在或已失效，请重新上传' });
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
    fileIds,
    // 附件名随提问一起落库：历史回看时还原附件标签，否则切换会话后用户看不出回答基于哪些文件
    attachmentNames: storedFiles.map((file) => file.name),
  });
}
