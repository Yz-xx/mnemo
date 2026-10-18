import type { ConcurrencyConfig } from '../../configuration/config/index.js';
import type { ChatStreamEvent } from '@repo/reusable';
import type { Response } from 'express';
import { createEventStream } from './eventStream.js';

/**
 * 对话通道：把「推一次 SSE 事件」所需的打开事件流、客户端断开中断、
 * 单轮超时定时器与背压慢客户端判定收在一处，让编排层只面对 send / signal / 两个标志。
 */
export interface ChatChannel {
  /** 推送一个 SSE 事件；背压超时即按慢客户端断开并中断本轮，避免内存继续堆积 */
  send(event: ChatStreamEvent): Promise<void>;
  /** 中断信号：客户端断开、单轮超时、慢客户端任一触发 */
  readonly signal: AbortSignal;
  /** 本轮是否因超时被中断 */
  readonly timedOut: boolean;
  /** 本轮是否因慢客户端（写缓冲满且等不到 drain）被断开 */
  readonly slowClient: boolean;
  /** 结束响应并清理定时器 */
  dispose(): void;
}

/** 建立一轮对话的 SSE 通道：打开响应流、装配中断源与超时兜底 */
export function createChatChannel(res: Response, config: ConcurrencyConfig): ChatChannel {
  const stream = createEventStream(res, config.sseDrainTimeoutMs);
  stream.open();

  // 注意：req 的 close 在请求体读取完成后即会触发（会误中断流式响应），故监听 res；
  // 排除 res.writableEnded 以跳过正常结束时的回调。
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  // 单轮最长时长：到点中断本轮，防止半死连接永久占住一个在途额度与一份内存
  let timedOut = false;
  const roundTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.chatMaxDurationMs);

  // 慢客户端：SSE 写缓冲满且等不到 drain，本轮已主动断开
  let slowClient = false;

  return {
    get signal() {
      return controller.signal;
    },
    get timedOut() {
      return timedOut;
    },
    get slowClient() {
      return slowClient;
    },
    async send(event: ChatStreamEvent): Promise<void> {
      if (await stream.send(event)) return;
      slowClient = true;
      controller.abort();
    },
    dispose(): void {
      clearTimeout(roundTimer);
      res.end();
    },
  };
}
