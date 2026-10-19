import type { ChatRound } from './round.js';
import type { MetricsRegistry } from '../../infrastructure/observability/index.js';
import type { Response } from 'express';
import { METRIC } from '../../infrastructure/observability/index.js';
import { createEventStream } from './eventStream.js';

/** 把轮次事件日志接到一个 HTTP 响应上的参数 */
export interface PipeRoundFramesInput {
  round: ChatRound;
  res: Response;
  /** 客户端的断点：只重放该序号之后的帧；0 表示从头开始 */
  fromSeq: number;
  /** 背压等待上限（毫秒）：写缓冲满且等不到 drain 即按慢客户端退订 */
  drainTimeoutMs: number;
  metrics: MetricsRegistry;
}

/**
 * 把一个轮次的事件流写进响应：订阅轮次日志并从断点续读，直到本轮结束、
 * 客户端断开或判定为慢客户端。
 *
 * 关键：客户端断开只退订本次订阅，不触达轮次——生成继续在后台跑完，
 * 客户端重连（或换一次 POST）可凭序号把这段补上。这正是断点续传的服务端半边，
 * 故断开信号只落在本地订阅控制器上，绝不往上传给 round.signal。
 */
export async function pipeRoundFrames({
  round,
  res,
  fromSeq,
  drainTimeoutMs,
  metrics,
}: PipeRoundFramesInput): Promise<void> {
  const stream = createEventStream(res, drainTimeoutMs);
  stream.open();

  // 本地订阅控制器：响应关闭时只退订本轮订阅
  const subscription = new AbortController();
  // 注意：req 的 close 在请求体读取完成后即会触发（会误中断流式响应），故监听 res；
  // 排除 res.writableEnded 以跳过正常结束时的回调
  const onClose = (): void => {
    if (!res.writableEnded) subscription.abort();
  };
  res.on('close', onClose);

  /** 本次订阅实际重放出去的帧数：仅续传场景计入指标 */
  let replayed = 0;
  try {
    for await (const frame of round.subscribe(fromSeq, subscription.signal)) {
      if (!(await stream.send(frame.event, frame.seq))) {
        // 背压超时（慢客户端）：退订即可，生成由轮次侧照常继续
        break;
      }
      if (fromSeq > 0) replayed += 1;
    }
  } finally {
    res.off('close', onClose);
    res.end();
    if (replayed > 0) metrics.increment(METRIC.SSE_REPLAYED_FRAMES, replayed);
  }
}
