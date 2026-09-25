/** 截断标记：附上原始长度，便于判断是"本来就这么短"还是"被截掉了" */
const ELLIPSIS = '…';

/** 对象转紧凑 JSON：无法序列化（循环引用等）时退回 String，保证预览自身不抛错 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 单行预览：把报文压成一行并限制长度。
 * 入参出参可能很长（请求体、响应体、模型回答），全量落盘会让日志文件迅速膨胀，
 * 因此统一走 preview 截断；调用方需先脱敏，避免只截断不遮蔽。
 */
export function preview(value: unknown, maxLength: number): string {
  const flattened = stringify(value).replace(/\s*\n\s*/g, ' ');
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength)}${ELLIPSIS}（共 ${flattened.length} 字符，已截断）`;
}
