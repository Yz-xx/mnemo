import type { Logger } from '@mnemo/logger';

/**
 * 依赖熔断半开（见 docs/adr/0010 决策 16）：模型或向量服务连续失败达阈值即进入
 * 快速失败，冷却一段时间后放一个探测请求，探测成功即恢复。
 *
 * 状态机：closed（正常）→ open（快速失败）→ half-open（探测在途）→ closed / open。
 * 依赖挂掉时若继续把请求排满队、逐个超时，比直接快速失败更糟。
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

/** 熔断打开或探测在途：本次调用被快速失败，不发起真实请求 */
export class CircuitOpenError extends Error {
  constructor(label: string) {
    super(`${label}暂时不可用，请稍后重试`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** 连续失败达该值即打开 */
  failureThreshold: number;
  /** 打开后冷却该时长再放一个探测（毫秒） */
  cooldownMs: number;
  /** 依赖名称，用于日志与错误文案 */
  label: string;
  logger?: Logger;
}

export interface CircuitBreaker {
  /** 是否放行本次调用：打开且冷却未到即拒绝；冷却到点放行一个探测（转半开） */
  allow(): boolean;
  /** 上报成功：清空失败计数并闭合 */
  onSuccess(): void;
  /** 上报失败：累计失败；半开探测失败即重新打开 */
  onFailure(): void;
  /** 上报中断：探测期间调用被撤销且无结果，退回打开状态以便冷却过后再探测；中断不计入失败 */
  onAbort(): void;
  state(): CircuitState;
}

/** 建一个熔断器：closed 直达，open 快速失败并在冷却到点后放一个探测，探测成败决定闭合或重新打开 */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const { failureThreshold, cooldownMs, label, logger } = options;
  let state: CircuitState = 'closed';
  let failures = 0;
  let openedAt = 0;

  return {
    /** 是否放行本次调用：closed 一律放行；open 且冷却已到则转半开并放行唯一探测；其余快速失败 */
    allow() {
      if (state === 'closed') return true;
      // 冷却结束：只放行一个探测（转半开），其余并发请求在探测有结果前继续快速失败
      if (state === 'open' && Date.now() - openedAt >= cooldownMs) {
        state = 'half-open';
        logger?.info('依赖熔断进入半开，放行一个探测请求', { dependency: label, cooldownMs });
        return true;
      }
      return false;
    },
    /** 上报成功：无论此前处于哪个状态都立即闭合并清空失败计数 */
    onSuccess() {
      if (state !== 'closed') logger?.info('依赖已恢复，熔断闭合', { dependency: label });
      state = 'closed';
      failures = 0;
    },
    /** 上报失败：半开探测失败即重新打开并重计冷却（不叠加阈值）；closed 下累计达阈值才打开 */
    onFailure() {
      // 探测失败：立刻重新打开并重新计冷却，不叠加阈值
      if (state === 'half-open') {
        state = 'open';
        openedAt = Date.now();
        logger?.warn('熔断探测失败，重新打开', { dependency: label });
        return;
      }
      failures += 1;
      if (failures >= failureThreshold) {
        state = 'open';
        openedAt = Date.now();
        failures = 0;
        logger?.warn('依赖连续失败，熔断打开', { dependency: label, failureThreshold, cooldownMs });
      }
    },
    /** 上报中断：仅半开探测需退回打开状态（中断不计入失败）；closed / open 下无需处理 */
    onAbort() {
      // 只处理探测在途这一种：退回打开状态，冷却过后重新放探测；
      // 冷却正是刚刚放行本次探测的原因，故不重置 openedAt，下个请求即可再探测
      if (state !== 'half-open') return;
      state = 'open';
      logger?.warn('熔断探测被中断，退回打开状态', { dependency: label });
    },
    state: () => state,
  };
}
