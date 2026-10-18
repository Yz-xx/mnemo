import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * 事件循环延迟采样（见 docs/adr/0010 决策 17）：上传解析这类主线程 CPU 密集计算
 * 会把事件循环卡住，而它没有返回值可观测——`monitorEventLoopDelay` 是 Node 内置直方图，
 * 按间隔读一次即可。定时器 unref，不阻止进程退出。
 */

/** 事件循环延迟样本（毫秒）：三个分位，够判断是否被同步计算卡住 */
export interface EventLoopLagSample {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface EventLoopSamplerOptions {
  /** 采样间隔（毫秒）：间隔越长开销越小，越短越能捕捉短时阻塞 */
  intervalMs: number;
  /** 每次采样回调：把样本交给调用方写入指标 */
  onSample: (sample: EventLoopLagSample) => void;
}

/** 纳秒转毫秒；无样本时直方图可能给出非有限值，一律按 0 处理 */
function toMs(nanoseconds: number): number {
  return Number.isFinite(nanoseconds) ? nanoseconds / 1e6 : 0;
}

/** 启动采样，返回停止函数 */
export function startEventLoopSampler(options: EventLoopSamplerOptions): () => void {
  const { intervalMs, onSample } = options;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  const timer = setInterval(() => {
    onSample({
      p50Ms: toMs(histogram.percentile(50)),
      p99Ms: toMs(histogram.percentile(99)),
      maxMs: toMs(histogram.max),
    });
    // 读完即清零：样本反映的是这一个间隔内的阻塞，而不是开机以来的累计
    histogram.reset();
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
