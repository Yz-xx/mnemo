import type { ChatRound, RoundAbortReason } from './round.js';
import type { MetricsRegistry } from '../../infrastructure/observability/index.js';
import type { Logger } from '@mnemo/logger';
import { METRIC } from '../../infrastructure/observability/index.js';
import { createChatRound } from './round.js';

/**
 * 同号轮次已存在：调用方（路由层）据此改为订阅既有轮次，
 * 而不是重复落一条用户消息再生成一遍——这是 POST 重试的幂等兜底。
 */
export class RoundConflictError extends Error {
  constructor(readonly roundId: string) {
    super(`轮次已存在：${roundId}`);
    this.name = 'RoundConflictError';
  }
}

/**
 * 在途轮次注册表：按轮次 ID 索引，负责建轮次、按归属取轮次、停机时中止全部。
 * 「后台续生成」的计数与上限判定收在这里，轮次自身不必知道全局有多少同伴。
 */
export interface RoundRegistry {
  /** 建一个轮次；同 ID 已存在时抛 RoundConflictError，避免同一轮重复生成 */
  create(userId: number, id: string): ChatRound;
  /** 取本用户名下的轮次；不存在或属他人时返回 null（对外表现为 404） */
  get(userId: number, id: string): ChatRound | null;
  /** 当前在途轮次数（含后台续生成） */
  activeCount(): number;
  /** 中止全部轮次：停机时调用，让在途生成尽快收尾 */
  abortAll(reason: RoundAbortReason): void;
}

/** 注册表装配参数 */
export interface RoundRegistryOptions {
  /** 单轮最长时长（毫秒）：透传给每个新建轮次 */
  roundMaxDurationMs: number;
  /** 已收尾轮次的事件日志保留时长（毫秒）：期间允许重连续传 */
  roundTtlMs: number;
  /** 允许同时后台续生成的轮次上限：超过即中止最老的一个 */
  detachedMaxRounds: number;
  /** 单轮事件日志帧数上限 */
  maxLogFrames: number;
  metrics: MetricsRegistry;
  logger: Logger;
}

/** 建一个轮次注册表：维护在途轮次与脱离轮次两个集合，并把仪表写入指标注册表 */
export function createRoundRegistry(options: RoundRegistryOptions): RoundRegistry {
  const { roundMaxDurationMs, roundTtlMs, detachedMaxRounds, maxLogFrames, metrics, logger } =
    options;
  /** 在途轮次：键为轮次 ID（由客户端生成，天然唯一，跨用户同 ID 视为同一轮次故要校验归属） */
  const rounds = new Map<string, ChatRound>();
  /**
   * 已无订阅者、仍在后台续生成的轮次：Set 保持插入顺序，
   * 超限时淘汰最老的那个，防止断开连接后算力无声堆积。
   */
  const detached = new Set<ChatRound>();

  /** 刷新两个当前值仪表：在途轮次数与后台续生成轮次数 */
  const publishGauges = (): void => {
    metrics.gauge(METRIC.SSE_ROUNDS_ACTIVE, rounds.size);
    metrics.gauge(METRIC.SSE_ROUNDS_DETACHED, detached.size);
  };

  /** 回收轮次：从两个集合移除并刷新仪表（事件日志随轮次对象一起被 GC） */
  const forget = (round: ChatRound): void => {
    rounds.delete(round.id);
    detached.delete(round);
    publishGauges();
  };

  /**
   * 轮次进入脱离（首个订阅者已全部离开）：
   * 已中止、已收尾的轮次不计——它们只是在等日志回收，不该占续生成额度。
   */
  const markIdle = (round: ChatRound): void => {
    if (round.ended || round.abortReason) return;
    detached.add(round);
    publishGauges();
    if (detached.size > detachedMaxRounds) {
      const oldest = detached.values().next().value;
      if (oldest && oldest !== round) {
        // 先移出集合再中止：它已不再续生成，仪表与额度都应立刻反映这一点
        detached.delete(oldest);
        logger.warn('后台续生成轮次超限，已中止最老一轮', { roundId: oldest.id });
        oldest.abort('detached-limit');
      }
    }
  };

  return {
    create(userId, id): ChatRound {
      if (rounds.has(id)) throw new RoundConflictError(id);
      // 轮次实例在回调里被引用，声明即赋值（回调都在赋值完成后才可能触发）
      const created = createChatRound({
        id,
        userId,
        maxDurationMs: roundMaxDurationMs,
        maxLogFrames,
        onIdle: () => markIdle(created),
        onEnd: () => {
          // 收尾后不立即回收：留 TTL 让客户端还能重放；定时器 unref，不阻止进程退出
          const timer = setTimeout(() => forget(created), roundTtlMs);
          timer.unref();
          publishGauges();
        },
      });
      rounds.set(id, created);
      publishGauges();
      return created;
    },
    get(userId, id): ChatRound | null {
      const round = rounds.get(id);
      // 归属校验：他人轮次一律不可见，不泄露「存在但不属于你」
      if (!round || round.userId !== userId) return null;
      return round;
    },
    activeCount(): number {
      return rounds.size;
    },
    abortAll(reason): void {
      // 复制一份再遍历：中止会触发订阅者唤醒等同步回调，避免边遍历边改集合
      for (const round of [...rounds.values()]) round.abort(reason);
    },
  };
}
