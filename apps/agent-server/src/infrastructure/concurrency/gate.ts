import type { Logger } from '@mnemo/logger';

/**
 * 通用有界并发闸门：软水位之上进有界队列，硬水位之上直接拒绝（见 docs/adr/0010 决策 3）。
 *
 * 它是进程内的通用原语，不绑定具体依赖：HTTP 分档闸门、模型闸门、摘要闸门、检索闸门
 * 都用它，只是水位与日志上下文不同。调用方拿到 'admitted' 后必须 release 归还额度。
 */

/** 申请结果：放行 / 过载拒绝 / 等待期间撤销 */
export type GateOutcome = 'admitted' | 'rejected' | 'aborted';

/** 拒绝原因：区分硬水位与队列满，与真实故障分开统计 */
export type GateRejectReason = 'hard-watermark' | 'queue-full';

/** 闸门水位与队列：四项成套，软水位不得高于硬水位 */
export interface BoundedGateLimits {
  /** 硬水位（在途上限）：达到即拒绝，同时是放行的并发上限 */
  maxInFlight: number;
  /** 软水位：在途达到它后新申请改为排队，恒不大于 maxInFlight */
  softLimit: number;
  /** 队列长度上限：队列满即拒绝，保证等待时间有上界 */
  queueLimit: number;
  /** 排队等待上限（毫秒）：超时即拒绝 */
  queueTimeoutMs: number;
}

/** 闸门观测快照：供健康检查与测试读取，不参与放行判定 */
export interface BoundedGateSnapshot {
  /** 当前在途（已放行未归还）数 */
  inFlight: number;
  /** 当前排队等待的申请数 */
  queued: number;
  /** 累计拒绝数（含队列满与等待超时），与真实故障分开统计 */
  rejected: number;
  /** 硬水位与队列上限：按同一口径解读上面三个数字 */
  maxInFlight: number;
  queueLimit: number;
}

/** 有界并发闸门：申请额度 → 用毕归还 */
export interface BoundedGate {
  /** 申请一个在途额度；signal 撤销时返回 aborted，不占着队列位置空等 */
  acquire(signal?: AbortSignal): Promise<GateOutcome>;
  /** 归还一个在途额度，并补位排队者 */
  release(): void;
  snapshot(): BoundedGateSnapshot;
}

/** 闸门日志上下文：让「拒绝」「超时」两类过载记录能被按来源检索 */
export interface BoundedGateOptions {
  /** 附加到每条日志的固定字段（如 HTTP 闸门传 { tier }），不参与放行判定 */
  logContext?: Record<string, unknown>;
  logger?: Logger;
}

/** 排队中的一次申请：被放行或撤销时二选一收尾 */
interface Waiting {
  admit: () => void;
  drop: () => void;
}

/**
 * 建一道有界闸门。放行规则（见 docs/adr/0010 决策 3）：
 * - 队列为空且未到软水位 → 直达，不让轻微负载开始排队；
 * - 队列非空，或已介于软硬水位之间 → 排队（队列满则拒绝）；
 * - 已达硬水位 → 直接拒绝。
 * 队列非空时一律排队而不插队，先到先得，等待时间才可预期。
 */
export function createBoundedGate(
  limits: BoundedGateLimits,
  options: BoundedGateOptions = {},
): BoundedGate {
  const { logger, logContext } = options;
  /** 在途额度数：已放行、尚未 release 的申请数，同时是放行与拒绝判定的依据 */
  let inFlight = 0;
  /** 累计拒绝数：含硬水位拒绝与排队超时，只增不减，仅用于快照观测 */
  let rejected = 0;
  /** 排队等待的申请队列：先到先得，元素是尚未收尾的一次申请 */
  const waiting: Waiting[] = [];

  /** 逐个放行排队者，直到在途数回到硬水位 */
  const drain = (): void => {
    while (waiting.length > 0 && inFlight < limits.maxInFlight) {
      inFlight += 1;
      waiting.shift()?.admit();
    }
  };

  /** 归还一个在途额度并补位排队者；已无额度时按空跑忽略，避免计数被额外递减 */
  const release = (): void => {
    if (inFlight <= 0) return;
    inFlight -= 1;
    drain();
  };

  /** 申请一个在途额度：未到软水位且无人排队则直达；软硬水位之间或队列非空则入队；
   *  已达硬水位或队列满即拒绝；signal 撤销时退出队列并返回 aborted */
  const acquire = (signal?: AbortSignal): Promise<GateOutcome> =>
    new Promise<GateOutcome>((resolve) => {
      // 调用前就已撤销（如连接在入队前断开）：直接按撤销收尾，
      // 否则已派发过的 abort 事件不会再触发，只能干等到排队超时
      if (signal?.aborted) {
        resolve('aborted');
        return;
      }
      if (waiting.length === 0 && inFlight < limits.softLimit) {
        inFlight += 1;
        resolve('admitted');
        return;
      }
      if (inFlight >= limits.maxInFlight || waiting.length >= limits.queueLimit) {
        rejected += 1;
        const reason: GateRejectReason =
          inFlight >= limits.maxInFlight ? 'hard-watermark' : 'queue-full';
        logger?.warn('并发闸门拒绝请求', {
          ...logContext,
          reason,
          inFlight,
          queued: waiting.length,
        });
        resolve('rejected');
        return;
      }

      /** 该次申请是否已收尾（放行 / 撤销 / 超时三选一），用于避免重复结算与重复计数 */
      let settled = false;
      /** 单次申请的收尾：幂等，取消超时定时器与 abort 监听、退出队列，再按最终结果兑现 Promise */
      let finish: (outcome: GateOutcome) => void = () => undefined;
      const entry: Waiting = {
        admit: () => finish('admitted'),
        drop: () => finish('aborted'),
      };
      /** 从排队队列中摘掉本次申请：收尾时队列里可能已无自己（已被放行取走） */
      const removeFromQueue = (): void => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
      };
      /** 排队期间调用方撤销（如客户端离开）时的回调：以 aborted 收尾 */
      const onAbort = (): void => finish('aborted');
      // 定时器先建好、finish 后赋值：既能在此处引用 finish，又不必用可变量持有句柄
      const timer = setTimeout(() => {
        // 已放行或已撤销的申请不再计入拒绝，避免超时口径虚高
        if (settled) return;
        rejected += 1;
        logger?.warn('并发闸门等待超时', {
          ...logContext,
          queued: waiting.length,
          timeoutMs: limits.queueTimeoutMs,
        });
        finish('rejected');
      }, limits.queueTimeoutMs);
      finish = (outcome: GateOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        removeFromQueue();
        resolve(outcome);
      };
      // 排队期间调用方撤销（如客户端离开）就退出队列，不占着位置空等到超时
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(entry);
    });

  return {
    acquire,
    release,
    /** 观测快照：在途、排队与累计拒绝数，连同水位口径一并返回 */
    snapshot: () => ({
      inFlight,
      queued: waiting.length,
      rejected,
      maxInFlight: limits.maxInFlight,
      queueLimit: limits.queueLimit,
    }),
  };
}

/** 退避建议：按排队上限折算成秒并向上取整，至少 1 秒 */
export function retryAfterSeconds(limits: BoundedGateLimits): number {
  return Math.max(1, Math.ceil(limits.queueTimeoutMs / 1000));
}
