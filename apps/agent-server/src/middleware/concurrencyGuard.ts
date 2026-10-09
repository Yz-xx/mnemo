import type { ConcurrencyConfig, GateConfig } from '../configuration/config/index.js';
import type { Logger } from '@repo/logger';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
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

/** 排队中的一次申请：被放行或撤销时二选一收尾 */
interface Waiting {
  admit: () => void;
  drop: () => void;
}

/** 申请结果：放行 / 过载拒绝 / 客户端在排队期间离开 */
type Outcome = 'admitted' | 'rejected' | 'aborted';

/** 单档闸门：在途计数 + 有界等待队列，释放时优先补位排队者 */
interface Gate {
  acquire(signal: AbortSignal): Promise<Outcome>;
  /** 归还一个在途额度，并补位排队者 */
  release(): void;
  snapshot(): GateSnapshot;
}

/** 退避建议：按该档排队上限折算成秒并向上取整，至少 1 秒 */
export function retryAfterSeconds(cfg: GateConfig): number {
  return Math.max(1, Math.ceil(cfg.queueTimeoutMs / 1000));
}

/**
 * 建一档闸门。放行规则（见 docs/adr/0010 决策 3）：
 * - 队列为空且未到软水位 → 直达，不让轻微负载开始排队；
 * - 队列非空，或已介于软硬水位之间 → 排队（队列满则拒绝）；
 * - 已达硬水位 → 直接拒绝。
 * 队列非空时一律排队而不插队，先到先得，等待时间才可预期。
 */
function createGate(tier: GuardTier, cfg: GateConfig, logger: Logger): Gate {
  let inFlight = 0;
  let rejected = 0;
  const waiting: Waiting[] = [];

  /** 逐个放行排队者，直到在途数回到硬水位 */
  const drain = (): void => {
    while (waiting.length > 0 && inFlight < cfg.maxInFlight) {
      inFlight += 1;
      waiting.shift()?.admit();
    }
  };

  const release = (): void => {
    inFlight -= 1;
    drain();
  };

  const acquire = (signal: AbortSignal): Promise<Outcome> =>
    new Promise<Outcome>((resolve) => {
      if (waiting.length === 0 && inFlight < cfg.softLimit) {
        inFlight += 1;
        resolve('admitted');
        return;
      }
      if (inFlight >= cfg.maxInFlight || waiting.length >= cfg.queueLimit) {
        rejected += 1;
        logger.warn('并发闸门拒绝请求', {
          tier,
          reason: inFlight >= cfg.maxInFlight ? 'hard-watermark' : 'queue-full',
          inFlight,
          queued: waiting.length,
        });
        resolve('rejected');
        return;
      }

      let settled = false;
      let finish: (outcome: Outcome) => void = () => undefined;
      const entry: Waiting = {
        admit: () => finish('admitted'),
        drop: () => finish('aborted'),
      };
      const removeFromQueue = (): void => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
      };
      const onAbort = (): void => finish('aborted');
      // 定时器先建好、finish 后赋值：既能在此处引用 finish，又不必用可变量持有句柄
      const timer = setTimeout(() => {
        // 已放行或已撤销的申请不再计入拒绝，避免超时口径虚高
        if (settled) return;
        rejected += 1;
        logger.warn('并发闸门等待超时', {
          tier,
          queued: waiting.length,
          timeoutMs: cfg.queueTimeoutMs,
        });
        finish('rejected');
      }, cfg.queueTimeoutMs);
      finish = (outcome: Outcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        removeFromQueue();
        resolve(outcome);
      };
      // 排队期间客户端离开就撤销申请，不占着队列位置空等到超时
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.push(entry);
    });

  return {
    acquire,
    release,
    snapshot: () => ({
      tier,
      inFlight,
      queued: waiting.length,
      rejected,
      maxInFlight: cfg.maxInFlight,
      queueLimit: cfg.queueLimit,
    }),
  };
}

/**
 * 并发闸门组合根：一次建好三档，路由层按档取中间件挂载。
 * 是有状态的内存设施，进程重启即清零、多实例下各算各的，不能当作全局配额（见 docs/adr/0010）。
 */
export function createConcurrencyGuard(
  config: ConcurrencyConfig,
  logger: Logger,
): ConcurrencyGuard {
  const gates: Record<GuardTier, Gate> = {
    chat: createGate('chat', config.chat, logger),
    upload: createGate('upload', config.upload, logger),
    crud: createGate('crud', config.crud, logger),
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
    snapshot: () => [gates.chat, gates.upload, gates.crud].map((gate) => gate.snapshot()),
  };
}
