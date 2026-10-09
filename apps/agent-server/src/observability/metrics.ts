/**
 * 进程内指标注册表（见 docs/adr/0010 决策 17）：只收集、只读快照，
 * 不做上报与落盘——指标去向（就绪检查 / 日志 / 压测脚本）由调用方决定。
 *
 * 三类量各司其职：计数器只增不减（拒绝数、池等待超时数），计量器为当前值
 * （排队深度、事件循环延迟），直方图记录耗时样本（分位数用于 SLO 判定）。
 * 直方图只保留最近 N 个样本：长跑下分位数仍有意义，内存却有上界。
 */

/** 直方图摘要：分位数与极值，用于耗时类指标的 SLO 判定 */
export interface HistogramSummary {
  /** 窗口内样本数 */
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** 指标快照：三类量各自成表，键为指标名 */
export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSummary>;
}

/** 指标注册表：埋点方只管写入，读取统一走 snapshot */
export interface MetricsRegistry {
  /** 累加计数：拒绝数、池等待超时数等只增不减的量 */
  increment(name: string, delta?: number): void;
  /** 覆盖式计量：当前值，如排队深度与事件循环延迟 */
  gauge(name: string, value: number): void;
  /** 记录一次耗时样本（毫秒） */
  observe(name: string, valueMs: number): void;
  snapshot(): MetricsSnapshot;
}

/** 默认窗口样本数：够算稳定的 P95，又不至于让长跑进程的表无限增长 */
const DEFAULT_HISTOGRAM_SIZE = 1024;

/**
 * 分位数取值：排序后按最近秩取，样本量小时即为最大值。
 * 观测用途足够，不引入 t-digest 之类的近似算法（见仓库「同一逻辑出现第三次才抽公共」）。
 */
function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/** 注册表构造选项 */
export interface MetricsOptions {
  /** 直方图窗口样本数：超过即丢最老样本，默认 1024 */
  histogramSize?: number;
}

export function createMetrics(options: MetricsOptions = {}): MetricsRegistry {
  const size = options.histogramSize ?? DEFAULT_HISTOGRAM_SIZE;
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  const histograms = new Map<string, number[]>();

  return {
    increment(name, delta = 1) {
      counters.set(name, (counters.get(name) ?? 0) + delta);
    },
    gauge(name, value) {
      gauges.set(name, value);
    },
    observe(name, valueMs) {
      const samples = histograms.get(name) ?? [];
      samples.push(valueMs);
      // 超出窗口即丢最老样本：分位数始终基于最近一段，内存有上界
      if (samples.length > size) samples.splice(0, samples.length - size);
      histograms.set(name, samples);
    },
    snapshot() {
      const result: MetricsSnapshot = {
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
        histograms: {},
      };
      for (const [name, samples] of histograms) {
        const sorted = [...samples].sort((a, b) => a - b);
        const sum = sorted.reduce((acc, value) => acc + value, 0);
        result.histograms[name] = {
          count: sorted.length,
          avgMs: sorted.length > 0 ? Math.round(sum / sorted.length) : 0,
          p50Ms: Math.round(percentile(sorted, 0.5)),
          p95Ms: Math.round(percentile(sorted, 0.95)),
          maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
        };
      }
      return result;
    },
  };
}
