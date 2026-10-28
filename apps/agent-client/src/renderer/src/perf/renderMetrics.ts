/**
 * 渲染性能采集（阶段 0/1，见 docs/adr/0016）：**只测量，不改变渲染行为**。
 *
 * 生产构建不安装采集器，`measureRender` 退化为直接调用；开发模式下把快照入口挂到
 * `window.__mnemoPerf`，供 DevTools 控制台读取。之所以把计时收在这里，是为了不让
 * 「是否测量」的判断散落到渲染路径上。
 *
 * 阶段 1 补上 DOM 更新耗时：`v-html` 重建节点的开销发生在浏览器渲染管线里，
 * 不在解析计时的窗口内，只有单独量这一段才能判断合帧究竟削减了哪部分（阶段 0 的口径盲区）。
 */

/** 一次快照的字段，与 ADR 0016「阶段 0 / 阶段 1」的基线口径一一对应 */
export interface RenderPerfSnapshot {
  /** Markdown 解析次数，等于渲染次数：逐 token 重解析问题的直接证据 */
  renderCount: number;
  /** 解析累计耗时（毫秒） */
  renderTotalMs: number;
  /** 单次解析平均耗时（毫秒） */
  renderAvgMs: number;
  /** 单次解析最长耗时（毫秒） */
  renderMaxMs: number;
  /** 组件更新（含 `v-html` 重建 DOM）次数 */
  domUpdateCount: number;
  /** 组件更新累计耗时（毫秒） */
  domUpdateTotalMs: number;
  /** 单次组件更新最长耗时（毫秒） */
  domUpdateMaxMs: number;
  /** 超过 50ms 的长任务数量 */
  longTaskCount: number;
  /** 长任务累计时长（毫秒） */
  longTaskTotalMs: number;
  /** 单个长任务最长时长（毫秒） */
  longTaskMaxMs: number;
  /** 当前文档中的 DOM 节点总数 */
  domNodes: number;
  /** JS 堆占用（MB）；取不到时为 null */
  heapUsedMb: number | null;
}

/** Chromium 的非标准扩展，TS 内置类型未声明 */
interface PerformanceMemory {
  usedJSHeapSize: number;
}

let enabled = false;
let renderCount = 0;
let renderTotalMs = 0;
let renderMaxMs = 0;
let domUpdateCount = 0;
let domUpdateTotalMs = 0;
let domUpdateMaxMs = 0;
let longTaskCount = 0;
let longTaskTotalMs = 0;
let longTaskMaxMs = 0;

const noop = (): void => {};

/** 采集长任务：仅 Chromium 支持 longtask 入口，不支持时静默跳过，其余指标照常采集 */
function observeLongTasks(): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskTotalMs += entry.duration;
        if (entry.duration > longTaskMaxMs) longTaskMaxMs = entry.duration;
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // 环境不支持 longtask 时，解析耗时与 DOM 指标仍然有效
  }
}

/** 读取堆占用：取不到时返回 null，而不是伪造一个 0 让基线看起来「正常」 */
function readHeapUsedMb(): number | null {
  const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
  if (!memory) return null;
  return Math.round((memory.usedJSHeapSize / 1024 / 1024) * 100) / 100;
}

/** 保留两位小数：基线表不需要比毫秒更细的精度，过多小数反而影响阅读 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function snapshot(): RenderPerfSnapshot {
  return {
    renderCount,
    renderTotalMs: round2(renderTotalMs),
    renderAvgMs: renderCount === 0 ? 0 : Math.round((renderTotalMs / renderCount) * 1000) / 1000,
    renderMaxMs: round2(renderMaxMs),
    domUpdateCount,
    domUpdateTotalMs: round2(domUpdateTotalMs),
    domUpdateMaxMs: round2(domUpdateMaxMs),
    longTaskCount,
    longTaskTotalMs: round2(longTaskTotalMs),
    longTaskMaxMs: round2(longTaskMaxMs),
    domNodes: document.getElementsByTagName('*').length,
    heapUsedMb: readHeapUsedMb(),
  };
}

export function reset(): void {
  renderCount = 0;
  renderTotalMs = 0;
  renderMaxMs = 0;
  domUpdateCount = 0;
  domUpdateTotalMs = 0;
  domUpdateMaxMs = 0;
  longTaskCount = 0;
  longTaskTotalMs = 0;
  longTaskMaxMs = 0;
}

/**
 * 包一次渲染并计时：未安装采集器时直接执行，不产生计时开销。
 * 注意它是「测量用的高阶函数」，不承担任何渲染语义——返回值原样透传。
 */
export function measureRender<T>(task: () => T): T {
  if (!enabled) return task();
  const startedAt = performance.now();
  const result = task();
  const durationMs = performance.now() - startedAt;
  renderCount += 1;
  renderTotalMs += durationMs;
  if (durationMs > renderMaxMs) renderMaxMs = durationMs;
  return result;
}

/**
 * 开始一次组件更新计时：在 `onBeforeUpdate` 里调用，返回的函数在 `onUpdated` 里调用。
 * 未安装采集器时返回空函数，调用点不必判断是否在测量。
 */
export function beginDomUpdate(): () => void {
  if (!enabled) return noop;
  const startedAt = performance.now();
  return () => {
    const durationMs = performance.now() - startedAt;
    domUpdateCount += 1;
    domUpdateTotalMs += durationMs;
    if (durationMs > domUpdateMaxMs) domUpdateMaxMs = durationMs;
  };
}

/** 安装采集器：仅开发模式生效，把快照入口挂到 window 供控制台调用 */
export function installRenderMetrics(): void {
  if (!import.meta.env.DEV) return;
  enabled = true;
  observeLongTasks();
  window.__mnemoPerf = { snapshot, reset };
}
