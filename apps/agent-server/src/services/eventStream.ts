import type { ChatStreamEvent } from '@repo/reusable';
import type { Response } from 'express';

/**
 * SSE 写出接缝：开启事件流、按帧推送，并在下游消费不过来时按背压等待 drain。
 * 客户端不再读取（缓冲已满且等不到 drain）即视为慢客户端，由调用方中断本轮，
 * 避免增量内容在 Node 侧写缓冲里无上限堆积（见 docs/adr/0010 决策 8）。
 */
export interface EventStream {
  /** 写出 SSE 响应头：禁用缓存与缓冲，保证增量内容即时到达客户端 */
  open(): void;
  /** 推送一个事件；返回 false 表示已判定为慢客户端（本轮应由调用方中断） */
  send(event: ChatStreamEvent): Promise<boolean>;
}

/** 建一个绑定到该响应的 SSE 写出器；drainTimeoutMs 为背压等待上限 */
export function createEventStream(res: Response, drainTimeoutMs: number): EventStream {
  /** 直写一帧：写缓冲满时等 drain，等不到则返回 false 交由调用方断开 */
  const writeChunk = (chunk: string): Promise<boolean> => {
    if (res.write(chunk)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      /** drain 与超时谁先到即定胜负，避免二者重复结算本次写入结果 */
      let settled = false;
      let settle: (ok: boolean) => void = () => undefined;
      /** drain 事件回调：将本次写入判定为成功 */
      const onDrain = (): void => settle(true);
      // 定时器先建好、settle 后赋值：既能在此处引用 settle，又不必用可变量持有句柄
      const timer = setTimeout(() => settle(false), drainTimeoutMs);
      settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res.off('drain', onDrain);
        resolve(ok);
      };
      res.once('drain', onDrain);
    });
  };

  return {
    open(): void {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
    },
    async send(event: ChatStreamEvent): Promise<boolean> {
      // 响应已结束：不再写入，也不算慢客户端
      if (res.writableEnded) return true;
      return writeChunk(`data: ${JSON.stringify(event)}\n\n`);
    },
  };
}
