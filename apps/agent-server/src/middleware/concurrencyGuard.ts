import type { BoundedGate } from '../concurrency/gate.js';
import type { ConcurrencyConfig } from '../configuration/config/index.js';
import type { Logger } from '@repo/logger';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { createBoundedGate, retryAfterSeconds } from '../concurrency/gate.js';
import { ERROR_MESSAGE } from '../configuration/messages.js';

/**
 * 闸门档位：健康检查不入闸门（过载时必须永远可答），其余三类各占一份配额。
 * 对话流占用长、上传解析 CPU 密集，各自单独配额，避免把管理端与健康检查一起拖失联。
 */
export type GuardTier = 'chat' | 'upload' | 'crud';

/** 单档闸门的观测快照：供健康检查与测试读取，不参与放行判定 */
export interface GateSnapshot {
  tier: GuardTier;
  /** 当前在途（已放行未收尾）请求数 */
  inFlight: number;
  /** 当前排队等待的请求数 */
  queued: number;
  /** 累计被拒绝数（含队列满与等待超时），与真实故障分开统计 */
  rejected: number;
  /** 硬水位与队列上限：按同一口径解读上面三个数字 */
  maxInFlight: number;
  queueLimit: number;
}

/** 并发闸门：按档申请在途额度，过载时以 503 拒绝 */
export interface ConcurrencyGuard {
  /** 取某一档的中间件：未到软水位直达，介于软硬水位之间排队，达到硬水位即拒绝 */
  middleware(tier: GuardTier): RequestHandler;
  /** 各档当前水位快照 */
  snapshot(): GateSnapshot[];
}

/** 挂闸门的三个档位：顺序同时决定快照顺序 */
const TIERS: GuardTier[] = ['chat', 'upload', 'crud'];

/**
 * 并发闸门组合根：一次建好三档，路由层按档取中间件挂载。
 * 有状态的内存设施，进程重启即清零、多实例下各算各的，不能当作全局配额（见 docs/adr/0010）。
 * 放行规则与水位语义由通用闸门承担（见 concurrency/gate.ts），这里只负责按档组装与 HTTP 收尾。
 */
export function createConcurrencyGuard(
  config: ConcurrencyConfig,
  logger: Logger,
): ConcurrencyGuard {
  const gates: Record<GuardTier, BoundedGate> = {
    chat: createBoundedGate(config.chat, { logger, logContext: { tier: 'chat' } }),
    upload: createBoundedGate(config.upload, { logger, logContext: { tier: 'upload' } }),
    crud: createBoundedGate(config.crud, { logger, logContext: { tier: 'crud' } }),
  };

  return {
    middleware(tier) {
      const gate = gates[tier];

      return (_req: Request, res: Response, next: NextFunction) => {
        // 排队期间由 close 事件撤销申请；放行后再换成归还额度
        const gone = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) gone.abort();
        };
        res.once('close', onClose);

        void gate.acquire(gone.signal).then((outcome) => {
          res.off('close', onClose);
          if (outcome !== 'admitted') {
            if (outcome === 'rejected') {
              // 过载是「可重试的临时态」：附 Retry-After 让客户端与网关退避重试
              res.setHeader('Retry-After', String(retryAfterSeconds(config[tier])));
              res
                .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
                .json({ message: ERROR_MESSAGE.OVERLOADED });
            }
            // aborted：连接已断开，没有可回复的对象
            return;
          }

          // 正常收尾与连接中断都要归还额度，两个事件都挂并做幂等
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            gate.release();
          };
          res.once('finish', release);
          res.once('close', release);
          next();
        });
      };
    },
    snapshot: () => TIERS.map((tier) => ({ tier, ...gates[tier].snapshot() })),
  };
}
