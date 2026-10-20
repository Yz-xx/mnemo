import type { AppConfig } from '../../configuration/config/index.js';
import type { CircuitBreaker } from '../../infrastructure/concurrency/circuitBreaker.js';
import type { BoundedGate } from '../../infrastructure/concurrency/gate.js';
import type { Logger } from '@mnemo/logger';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { describeChatModel } from '../../configuration/config/index.js';
import {
  CircuitOpenError,
  createCircuitBreaker,
} from '../../infrastructure/concurrency/circuitBreaker.js';
import { createBoundedGate } from '../../infrastructure/concurrency/gate.js';

/**
 * 模型侧治理（见 docs/adr/0010 决策 9、10、16）：把模型闸门、摘要闸门与熔断器收在一处，
 * 由 AgentService 只按「进入一轮 / 结束一轮 / 回报结果」使用。
 *
 * - 模型闸门：真实瓶颈在模型算力，申请额度排队超时或达硬水位即拒绝；
 * - 摘要闸门：独立低优先额度，满即拒绝，由上层 contextGovernance 捕获后退化为丢弃最老历史；
 * - 熔断器：模型连续失败即快速失败，冷却后放一个探测。
 * 三者都是进程内状态，重启即清零；水位与阈值统一由 env.ts 收敛。
 */

/**
 * 模型额度拒绝：属「可重试的过载」，与真实故障分开统计与提示（决策 17）。
 * 摘要额度被占也复用它，由上层统一按「本轮放弃摘要」降级。
 */
export class ModelOverloadedError extends Error {
  constructor() {
    super(ERROR_MESSAGE.OVERLOADED);
    this.name = 'ModelOverloadedError';
  }
}

/** 申请模型额度期间被中断（客户端离开或单轮超时）：按中断收尾，不当成依赖故障 */
export class RoundInterruptedError extends Error {
  constructor() {
    super('本轮对话已中断');
    this.name = 'RoundInterruptedError';
  }
}

export class ModelGovernance {
  private readonly modelGate: BoundedGate;
  private readonly summaryGate: BoundedGate;
  private readonly breaker: CircuitBreaker;

  constructor(config: AppConfig, logger?: Logger) {
    this.modelGate = createBoundedGate(config.concurrency.model, {
      logger,
      logContext: { gate: 'model' },
    });
    this.summaryGate = createBoundedGate(config.concurrency.summary, {
      logger,
      logContext: { gate: 'summary' },
    });
    this.breaker = createCircuitBreaker({
      failureThreshold: config.concurrency.circuitFailureThreshold,
      cooldownMs: config.concurrency.circuitCooldownMs,
      label: `对话模型服务 ${describeChatModel(config)}`,
      logger,
    });
  }

  /**
   * 进入一轮对话：先申请模型额度（排队超时即按过载拒绝），再查熔断（打开即快速失败）。
   * 两者都在发起真实调用之前挡下，避免把压力转成一大批并发超时（决策 9、16）。
   */
  async enterRound(signal?: AbortSignal): Promise<void> {
    const outcome = await this.modelGate.acquire(signal);
    if (outcome === 'aborted') throw new RoundInterruptedError();
    if (outcome === 'rejected') throw new ModelOverloadedError();
    // 熔断打开时立刻归还额度，不留着一个被拒绝的申请占位
    if (!this.breaker.allow()) {
      this.modelGate.release();
      throw new CircuitOpenError('对话模型服务');
    }
  }

  /** 一轮结束：归还模型额度，与 enterRound 配对 */
  exitRound(): void {
    this.modelGate.release();
  }

  /** 整轮成功：熔断计数归零并闭合 */
  reportSuccess(): void {
    this.breaker.onSuccess();
  }

  /**
   * 整轮失败：客户端中断不算依赖故障，但要归还半开探测名额，
   * 否则熔断会永久停在半开、再也放不出探测（见 CircuitBreaker.onAbort）。
   */
  reportFailure(aborted: boolean): void {
    if (aborted) this.breaker.onAbort();
    else this.breaker.onFailure();
  }

  /**
   * 生成滚动摘要：走独立低优先额度，额度被占即拒绝（由上层降级为丢弃最老历史），
   * 绝不挤占用户可见的首 token 时延（决策 10）。
   */
  async summarize<T>(task: () => Promise<T>): Promise<T> {
    const outcome = await this.summaryGate.acquire();
    if (outcome !== 'admitted') throw new ModelOverloadedError();
    try {
      return await this.runBreaker(task);
    } finally {
      this.summaryGate.release();
    }
  }

  /** 包一次模型调用：熔断打开即快速失败；成功与失败都回报给熔断器 */
  private async runBreaker<T>(task: () => Promise<T>): Promise<T> {
    if (!this.breaker.allow()) throw new CircuitOpenError('对话模型服务');
    try {
      const result = await task();
      this.breaker.onSuccess();
      return result;
    } catch (error) {
      this.breaker.onFailure();
      throw error;
    }
  }
}
