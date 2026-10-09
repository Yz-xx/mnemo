import type { Logger } from '@repo/logger';
import { describe, expect, it } from 'vitest';
import { CircuitOpenError, createCircuitBreaker } from '../concurrency/circuitBreaker.js';

/** 静默日志替身：熔断开合会记 info / warn，用例不关心日志内容 */
const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

/** 等一小段真实时间：冷却判定基于 Date.now，用真实计时比伪造时钟更贴近运行形态 */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('createCircuitBreaker', () => {
  it('连续失败未达阈值时保持闭合，照常放行', () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      label: '向量化服务',
      logger,
    });
    breaker.onFailure();
    breaker.onFailure();

    expect(breaker.state()).toBe('closed');
    expect(breaker.allow()).toBe(true);
  });

  it('连续失败达阈值即打开，后续调用快速失败', () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      label: '向量化服务',
      logger,
    });
    breaker.onFailure();
    breaker.onFailure();

    expect(breaker.state()).toBe('open');
    expect(breaker.allow()).toBe(false);
  });

  it('中途成功一次即清空失败计数，不因累计次数误开', () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      label: '向量化服务',
      logger,
    });
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();

    expect(breaker.state()).toBe('closed');
  });

  it('冷却未到时仍快速失败，不提前放探测', () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5000,
      label: '向量化服务',
      logger,
    });
    breaker.onFailure();

    expect(breaker.allow()).toBe(false);
  });

  it('冷却到点只放行一个探测，探测在途时其余请求继续被拒', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      label: '向量化服务',
      logger,
    });
    breaker.onFailure();
    expect(breaker.allow()).toBe(false);

    await wait(15);
    // 第一个请求转为探测（半开），其余并发请求在探测有结果前仍快速失败
    expect(breaker.allow()).toBe(true);
    expect(breaker.state()).toBe('half-open');
    expect(breaker.allow()).toBe(false);
  });

  it('探测成功即闭合，恢复常态放行', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      label: '向量化服务',
      logger,
    });
    breaker.onFailure();
    await wait(15);
    breaker.allow();
    breaker.onSuccess();

    expect(breaker.state()).toBe('closed');
    expect(breaker.allow()).toBe(true);
  });

  it('探测失败即重新打开，并重新开始计冷却', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 50,
      label: '向量化服务',
      logger,
    });
    breaker.onFailure();
    await wait(60);
    breaker.allow();
    breaker.onFailure();

    expect(breaker.state()).toBe('open');
    // 冷却已重新计时：立刻再问仍是拒绝
    expect(breaker.allow()).toBe(false);
  });

  it('探测被中断即退回打开，不会永久卡在半开、下个请求可再探测', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      label: '向量化服务',
      logger,
    });
    breaker.onFailure();
    await wait(15);
    // 冷却到点放行探测（转半开）后，该次调用被用户中断、既无成功也无失败
    expect(breaker.allow()).toBe(true);
    expect(breaker.state()).toBe('half-open');
    breaker.onAbort();

    // 退回打开而非停在半开：冷却已过，下一次请求能立刻再探测，避免永久快速失败
    expect(breaker.state()).toBe('open');
    expect(breaker.allow()).toBe(true);
    expect(breaker.state()).toBe('half-open');
  });

  it('闭合状态下的中断不计入失败，状态与计数都不变', () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      label: '向量化服务',
      logger,
    });
    breaker.onAbort();

    expect(breaker.state()).toBe('closed');
    expect(breaker.allow()).toBe(true);
    // 中断不算失败：随后一次失败仍未达阈值
    breaker.onFailure();
    expect(breaker.state()).toBe('closed');
  });

  it('熔断错误带上依赖名，便于定位是哪一个服务不可用', () => {
    expect(new CircuitOpenError('向量化服务').message).toContain('向量化服务');
  });
});
