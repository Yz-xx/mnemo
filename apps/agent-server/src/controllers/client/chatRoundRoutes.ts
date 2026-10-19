import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response, Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { METRIC } from '../../infrastructure/observability/index.js';
import { currentUserId } from '../../middleware/auth.js';
import { pipeRoundFrames } from '../../services/conversation/roundPipe.js';

/** 续传与停止接口需要的依赖 */
type RoundRouteDependencies = Pick<AppDependencies, 'rounds' | 'config' | 'metrics'>;

/** 解析断点序号：非数字或非正数一律按 0（从头开始），避免脏查询串把重放窗口算歪 */
function parseLastEventId(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 续传入口：客户端拿着轮次 ID 与已消费到的最大序号重连，服务端从该序号之后
 * 重放事件日志并接上实时帧；轮次不存在或已过期时按 404 返回，
 * 客户端据此降级为「重新拉取整条会话」。
 */
export async function handleRoundResume(
  { rounds, config, metrics }: RoundRouteDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  // 路径参数在 Express 类型下可能是数组，非字符串一律按空串（随后按 404 处理）
  const round = rounds.get(
    currentUserId(res),
    typeof req.params.roundId === 'string' ? req.params.roundId : '',
  );
  if (!round) {
    // 轮次不存在 / 已过期 / 不属于当前用户：一律 404，不区分原因
    metrics.increment(METRIC.SSE_RESUME_FAILED);
    res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.ROUND_NOT_FOUND });
    return;
  }
  metrics.increment(METRIC.SSE_RESUMES);
  await pipeRoundFrames({
    round,
    res,
    fromSeq: parseLastEventId(req.query.lastEventId),
    drainTimeoutMs: config.concurrency.sseDrainTimeoutMs,
    metrics,
  });
}

/** 停止入口：中止本轮生成；中止原因记为 user，收尾时由轮次任务回推一条 error 帧 */
export function handleRoundStop(
  { rounds }: RoundRouteDependencies,
  req: Request,
  res: Response,
): void {
  // 路径参数在 Express 类型下可能是数组，非字符串一律按空串（随后按 404 处理）
  const round = rounds.get(
    currentUserId(res),
    typeof req.params.roundId === 'string' ? req.params.roundId : '',
  );
  if (!round) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.ROUND_NOT_FOUND });
    return;
  }
  round.abort('user');
  res.status(HTTP_STATUS.NO_CONTENT).end();
}

/**
 * 轮次续传与停止接口：挂在 `/api/chat` 前缀下，模块内只写子路径
 * （前缀给分类、内部给子路径，避免叠加成重复段）。
 */
export function mountChatRoundRoutes(router: Router, deps: RoundRouteDependencies): void {
  router.get('/rounds/:roundId/stream', async (req, res) => {
    await handleRoundResume(deps, req, res);
  });
  router.post('/rounds/:roundId/stop', (req, res) => {
    handleRoundStop(deps, req, res);
  });
}
