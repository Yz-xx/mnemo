import type { BoundedGate } from '../concurrency/gate.js';
import type { AppConfig } from '../configuration/config/index.js';
import type { Logger } from '@repo/logger';
import { createBoundedGate } from '../concurrency/gate.js';
import { ERROR_MESSAGE } from '../configuration/messages.js';

/**
 * 附件解析治理（见 docs/adr/0010 决策 14）：docx / xlsx / pdf 解析是主线程 CPU 密集计算，
 * 一次并发解析就能把在途的 SSE 推送一起卡住。这里给它一道独立小额度。
 *
 * 解析的入口是 readAttachmentText，而它被对话轮的「附件预读」与 read_file 工具共用——
 * 也就是说解析不在上传请求内发生，故额度与入口的 HTTP 上传档分开计量。
 *
 * 用闸门而非 worker_threads：把解析挪进工作线程是决策 14 列出的备选，暂不落地——
 * 闸门已能把这批 CPU 工作收在小额度内、避免拖垮事件循环，而工作线程还要另行处理
 * 线程池、字节跨线程传递与错误回传，其收益（真正的并行）在单机解析频次不高时不值这份复杂度。
 */

/** 解析额度拒绝：属可重试的过载，读路径据此降级为「读取失败」而不中断整轮（决策 11、14） */
export class ParseOverloadedError extends Error {
  constructor() {
    super(ERROR_MESSAGE.OVERLOADED);
    this.name = 'ParseOverloadedError';
  }
}

/** 解析治理接口：调用方只关心「按额度跑一次解析」，水位与降级口径都藏在实现里 */
export interface ParseRunner {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export class ParseGovernance implements ParseRunner {
  private readonly gate: BoundedGate;

  constructor(config: AppConfig, logger?: Logger) {
    this.gate = createBoundedGate(config.concurrency.parse, {
      logger,
      logContext: { gate: 'parse' },
    });
  }

  /** 申请解析额度并执行；额度被拒或排队超时即抛错，由读路径捕获后降级 */
  async run<T>(task: () => Promise<T>): Promise<T> {
    const outcome = await this.gate.acquire();
    if (outcome !== 'admitted') throw new ParseOverloadedError();
    try {
      return await task();
    } finally {
      this.gate.release();
    }
  }
}
