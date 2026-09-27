/**
 * 通用工具函数
 */

/** 将数值限制在 [min, max] 区间内 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 延迟指定毫秒数，常用于异步流程控制与简单节流场景 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 提取错误消息：非 Error 抛出值（字符串、对象等）转为字符串。
 * 请求失败与流式中断抛出的都是 unknown，两端都需要同一个降级口径，
 * 否则界面会渲染成空提示、日志会丢掉原因。
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
