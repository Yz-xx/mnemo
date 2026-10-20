import type { AppDependencies } from '../../configuration/dependencies.js';
import type { ChatRound } from '../../services/conversation/round.js';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { retryAfterSeconds } from '../../infrastructure/concurrency/gate.js';
import { ConversationBusyError } from '../../infrastructure/concurrency/lock.js';
import { currentUserId } from '../../middleware/auth.js';
import { requestLogger } from '../../middleware/requestLog.js';
import { startChatRound } from '../../services/conversation/chatStream.js';
import { getOwnConversation } from '../../services/conversation/conversations.js';
import { pipeRoundFrames } from '../../services/conversation/roundPipe.js';
import { listOwnFiles } from '../../services/files.js';
import { mountChatRoundRoutes } from './chatRoundRoutes.js';

/** 本轮对话需要的依赖：只取用到的几项，便于单独编排与测试 */
type ChatDependencies = Pick<
  AppDependencies,
  'agent' | 'conversations' | 'files' | 'config' | 'chatLock' | 'rounds' | 'metrics'
>;

/** 合法轮次 ID 的形状：客户端生成的标准 UUID */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 对话接口：校验入参后交由轮次编排整轮对话；续传与停止接口一并挂在该前缀下 */
export function createChatRouter(deps: ChatDependencies): Router {
  const router = Router();

  router.post('/', (req, res) => handleChatMessage(deps, req, res));
  // 续传与停止同属对话前缀，交由独立模块注册子路径（避免前缀与路径叠加成重复段）
  mountChatRoundRoutes(router, deps);

  return router;
}

/** 归整入参中的附件 ID：非数组视为没有附件，剔除空值与重复项，不让脏数据进入工具层的可读名单 */
function parseFileIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  return [...new Set(ids)];
}

/** 解析客户端给的轮次 ID：非法（缺失或非 UUID）时服务端自行生成，旧客户端因此不受影响 */
function resolveRoundId(value: unknown): string {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : randomUUID();
}

/**
 * 单轮对话入口：只做入参与会话、附件归属校验，编排交给服务层。
 * 响应先不打开 SSE，直到轮次建好才订阅——排队超时与建轮次失败都要能按普通 JSON 返回。
 */
export async function handleChatMessage(
  { agent, conversations, files, config, chatLock, rounds, metrics }: ChatDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  const userId = currentUserId(res);
  const body = req.body as {
    conversationId?: string;
    message?: string;
    fileIds?: unknown;
    roundId?: unknown;
  };
  const content = typeof body.message === 'string' ? body.message.trim() : '';
  if (!content) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '消息内容不能为空' });
    return;
  }
  const roundId = resolveRoundId(body.roundId);
  const drainTimeoutMs = config.concurrency.sseDrainTimeoutMs;

  // 同号轮次已在途：本次是客户端重试的 POST，直接订阅既有轮次从头重放，
  // 不再重复落库与生成（幂等键即轮次 ID）
  const existing = rounds.get(userId, roundId);
  if (existing) {
    await pipeRoundFrames({ round: existing, res, fromSeq: 0, drainTimeoutMs, metrics });
    return;
  }

  // 指定了不存在（或不属于当前用户）的会话时直接报错，避免静默新建导致混淆。
  // 这次读入的历史一并透传给编排层，本轮不再回读（见 docs/adr/0010 决策 13）
  const history = body.conversationId
    ? await getOwnConversation(conversations, userId, body.conversationId)
    : null;
  if (body.conversationId && !history) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.CONVERSATION_NOT_FOUND });
    return;
  }
  // 附件同样先验归属：有不存在的就报错，否则模型拿到空清单后会答成“没有附件”，让人以为是上传失败
  const fileIds = parseFileIds(body.fileIds);
  const storedFiles = fileIds.length > 0 ? await listOwnFiles(files, userId, fileIds) : [];
  if (fileIds.length > 0 && storedFiles.length !== fileIds.length) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ message: '附件不存在或已失效，请重新上传' });
    return;
  }

  const logger = requestLogger(res);
  // 轮次就绪信号：建轮次成功给轮次实例，排队超时或建轮次失败给 null（错误另存）
  let setupError: unknown = null;
  let notifyReady: (round: ChatRound | null) => void = () => undefined;
  const ready = new Promise<ChatRound | null>((resolve) => {
    notifyReady = resolve;
  });

  /** 建轮次后把整轮跑完：轮次任务自吞异常，故本 Promise 只在建轮次阶段可能失败 */
  const run = async (): Promise<void> => {
    try {
      const started = await startChatRound({
        rounds,
        agent,
        conversations,
        logger,
        userId,
        roundId,
        conversationId: body.conversationId,
        history: history ?? undefined,
        content,
        fileIds,
        // 附件名随提问一起落库：历史回看时还原附件标签
        attachmentNames: storedFiles.map((file) => file.name),
        contextConfig: config.llm.context,
      });
      notifyReady(started.round);
      // 锁持有到整轮结束：同会话不并行两轮（done 永不 reject）
      await started.done;
    } catch (error) {
      setupError = error;
      notifyReady(null);
    }
  };

  // 新建会话无并发可言；既有会话同刻只跑一轮，等待超过上限按可重试过载返回 503
  // （见 docs/adr/0010 决策 12）
  const task = (body.conversationId ? chatLock.run(body.conversationId, run) : run()).catch(
    // 锁在未取得执行权时也会拒绝（排队超时，此时 run 从未被调用）：
    // 必须在此补一次就绪通知，否则下面 await ready 会永远挂住
    (error: unknown) => {
      setupError = error;
      notifyReady(null);
    },
  );

  const round = await ready;
  if (!round) {
    // 建轮次失败时任务已收尾（notifyReady 是它的最后一步），等它落定以免留下未处理的拒绝
    await task;
    if (setupError instanceof ConversationBusyError) {
      res.setHeader('Retry-After', String(retryAfterSeconds(config.concurrency.chat)));
      res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({ message: ERROR_MESSAGE.OVERLOADED });
      return;
    }
    throw setupError;
  }

  // 订阅轮次事件流：轮次与请求在此解耦，客户端断开只退订，生成继续在后台跑完
  try {
    await pipeRoundFrames({ round, res, fromSeq: 0, drainTimeoutMs, metrics });
  } finally {
    await task;
  }
}
