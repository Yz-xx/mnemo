import type { GateConfig } from './types.js';
import type { LogLevel } from '@repo/logger';
import process from 'node:process';

/** 逗号分隔列表：去空白、统一小写、去重，避免大小写或多余空格让白名单静默失效 */
export function toList(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) return fallback;
  const items = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(items)];
}

/** 正数配置取值：非法或 ≤0 一律退回默认值；非负计数用 toCount、比例用 toRatio，取值域各自收窄 */
export function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 非负整数：0 有意义的计数用它（如队列长度上限 0 表示不排队），与只收正数的 toNumber 区分 */
export function toCount(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 可按档读取水位的闸门前缀：入口三档 + 模型 / 摘要 / 检索 / 附件解析四道内部闸门 */
export type GatePrefix = 'CHAT' | 'UPLOAD' | 'CRUD' | 'MODEL' | 'SUMMARY' | 'RETRIEVAL' | 'PARSE';

/** 按档组装闸门：四项水位成套读取，缺省或非法时回落到该档默认值 */
export function readGate(prefix: GatePrefix, fallback: GateConfig): GateConfig {
  const maxInFlight = toNumber(
    process.env[`CONCURRENCY_${prefix}_MAX_IN_FLIGHT`],
    fallback.maxInFlight,
  );
  const softLimit = toNumber(process.env[`CONCURRENCY_${prefix}_SOFT_LIMIT`], fallback.softLimit);
  return {
    maxInFlight,
    // 软水位不得高于硬水位：否则一进入排队就再也等不到放行
    softLimit: Math.min(softLimit, maxInFlight),
    queueLimit: toCount(process.env[`CONCURRENCY_${prefix}_QUEUE_LIMIT`], fallback.queueLimit),
    queueTimeoutMs: toNumber(
      process.env[`CONCURRENCY_${prefix}_QUEUE_TIMEOUT_MS`],
      fallback.queueTimeoutMs,
    ),
  };
}

/** 比例取值：限定在 (0, 1] 内，越界或非法一律退回默认值，避免配错把上下文整段裁空 */
export function toRatio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

/** 日志级别：非法值一律退回 info，避免拼错环境变量导致日志全部静默 */
export function toLogLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}
