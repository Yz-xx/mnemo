import { afterEach, describe, expect, it, vi } from 'vitest';

// 拦截 Node 内置直方图：用例聚焦「采样 → 换算 → 回调 → 停止」这条链，不依赖真实事件循环
const { monitorEventLoopDelay } = vi.hoisted(() => ({ monitorEventLoopDelay: vi.fn() }));
vi.mock('node:perf_hooks', () => ({ monitorEventLoopDelay }));

const { startEventLoopSampler } = await import('../../infrastructure/observability/eventLoop.js');

/** 假直方图：percentile 按传入分位返回纳秒值，便于验证换算 */
function fakeHistogram(nanos: Record<number, number>, maxNanos: number) {
  return {
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    percentile: vi.fn((ratio: number) => nanos[ratio] ?? 0),
    max: maxNanos,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startEventLoopSampler', () => {
  it('按间隔把纳秒样本换算成毫秒回调，读完即清零', async () => {
    const histogram = fakeHistogram({ 50: 5e6, 99: 20e6 }, 30e6);
    monitorEventLoopDelay.mockReturnValue(histogram);
    const onSample = vi.fn();

    const stop = startEventLoopSampler({ intervalMs: 5, onSample });
    await new Promise((resolve) => setTimeout(resolve, 25));
    stop();

    expect(onSample).toHaveBeenCalled();
    // 5e6ns → 5ms，20e6ns → 20ms，max 30e6ns → 30ms
    expect(onSample.mock.calls[0][0]).toEqual({ p50Ms: 5, p99Ms: 20, maxMs: 30 });
    expect(histogram.reset).toHaveBeenCalled();
    expect(histogram.disable).toHaveBeenCalled();
  });

  it('停止后不再回调，避免停机后仍写入指标', async () => {
    monitorEventLoopDelay.mockReturnValue(fakeHistogram({ 50: 1e6, 99: 2e6 }, 3e6));
    const onSample = vi.fn();

    const stop = startEventLoopSampler({ intervalMs: 5, onSample });
    await new Promise((resolve) => setTimeout(resolve, 15));
    stop();
    const callsAtStop = onSample.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSample.mock.calls.length).toBe(callsAtStop);
  });

  it('直方图给出非有限值时按 0 处理，不把 NaN 写进指标', async () => {
    const histogram = fakeHistogram({}, Number.NaN);
    histogram.percentile.mockReturnValue(Number.NaN);
    monitorEventLoopDelay.mockReturnValue(histogram);
    const onSample = vi.fn();

    const stop = startEventLoopSampler({ intervalMs: 5, onSample });
    await new Promise((resolve) => setTimeout(resolve, 15));
    stop();

    expect(onSample.mock.calls[0][0]).toEqual({ p50Ms: 0, p99Ms: 0, maxMs: 0 });
  });
});
