import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { currentUserId } from '../../auth/middleware.js';
import { ERROR_MESSAGE } from '../../configuration/messages.js';
import { ConversationBusyError } from '../../conversation/lock.js';
import { retryAfterSeconds } from '../../middleware/concurrencyGuard.js';
import { requestLogger } from '../../middleware/requestLog.js';
import { streamChatReply } from '../../services/chatStream.js';

/** 本轮对话需要的依赖：只取用到的几项，便于单独编排与测试 */
type ChatDependencies = Pick<
  AppDependencies,
  'agent' | 'conversations' | 'files' | 'config' | 'chatLock'
>;

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
  { agent, conversations, files, config, chatLock }: ChatDependencies,
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
  // 指定了不存在（或不属于当前用户）的会话时直接报错，避免静默新建导致混淆。
  // 这次读入的历史一并透传给编排层，本轮不再回读（见 docs/adr/0010 决策 13）
  const history = body.conversationId ? await conversations.get(userId, body.conversationId) : null;
  if (body.conversationId && !history) {
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

  const reply = (): Promise<void> =>
    streamChatReply({
      res,
      agent,
      conversations,
      logger: requestLogger(res),
      userId,
      conversationId: body.conversationId,
      // 路由层读入的会话历史：交给编排层一次性使用，服务层不再重复回读
      history: history ?? undefined,
      content,
      fileIds,
      // 附件名随提问一起落库：历史回看时还原附件标签，否则切换会话后用户看不出回答基于哪些文件
      attachmentNames: storedFiles.map((file) => file.name),
      // 配置只取用到的两项：不让整个 AppConfig 穿透到服务层
      contextConfig: config.llm.context,
      concurrencyConfig: config.concurrency,
    });

  // 新建会话没有并发可言，无需串行；既有会话同刻只跑一轮，
  // 等待超过上限按「可重试的过载」返回 503（见 docs/adr/0010 决策 12）
  if (!body.conversationId) {
    await reply();
    return;
  }
  try {
    await chatLock.run(body.conversationId, reply);
  } catch (error) {
    if (error instanceof ConversationBusyError) {
      res.setHeader('Retry-After', String(retryAfterSeconds(config.concurrency.chat)));
      res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({ message: ERROR_MESSAGE.OVERLOADED });
      return;
    }
    throw error;
  }
}
