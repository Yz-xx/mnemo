/** 后端时间统一是 UTC ISO 串，界面按本地时区展示：直接截断会少 8 小时 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
