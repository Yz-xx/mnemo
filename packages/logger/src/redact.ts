import type { LogFields } from './types.js';

/** 命中即遮蔽的字段名：密码与令牌会随日志长期落盘，绝不能明文写入 */
const SECRET_KEY = /pass|pwd|token|secret|authorization|cookie|api[_-]?key/i;

const MASK = '***';

/** 递归深度上限：正常字段不会更深，同时天然阻断循环引用导致的无限递归 */
const MAX_DEPTH = 4;

function redact(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  // 时间与错误对象由格式化层专门渲染，展开成普通对象反而会丢掉堆栈
  if (value instanceof Date || value instanceof Error) return value;
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY.test(key) ? MASK : redact(item, depth + 1);
  }
  return result;
}

/** 遮蔽任意值：报文类数据（请求体 / 响应体）可能不是普通对象，故独立导出 */
export function redactValue(value: unknown): unknown {
  return redact(value, 0);
}

/** 遮蔽敏感字段：对字段名做正则判定，避免每种调用点各自记得脱敏 */
export function redactFields(fields: LogFields): LogFields {
  return redact(fields, 0) as LogFields;
}
