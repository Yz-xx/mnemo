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
