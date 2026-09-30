/**
 * 时间格式化工具：把后端下发的 UTC 时刻转成界面可读文本，与业务无关。
 */

/**
 * UTC ISO 串按本地时区展示。后端存的是 UTC，直接截取字符串会少 8 小时；
 * 解析失败（字段为空或格式不符）时返回破折号占位，避免界面留下空白。
 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * Date 转本地日期字符串（YYYY-MM-DD）。
 * 用本地字段拼装而不走 `toISOString`：后者按 UTC 输出，东八区的当地零点会被偏移到前一天。
 */
export function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
