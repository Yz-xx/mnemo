/**
 * 字符串相关工具函数
 */

/** 类型守卫：判断给定值是否为字符串 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** 将字符串首字母转为大写，其余字符保持不变 */
export function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * 截断字符串到指定长度，超出部分以省略号结尾
 * @param str    原始字符串
 * @param maxLen 允许的最大长度（含省略号），至少为 1
 */
export function truncate(str: string, maxLen: number): string {
  if (maxLen < 1) throw new Error('maxLen 必须大于等于 1');
  if (str.length <= maxLen) return str;
  // 省略号占一个字符，正文最多保留 maxLen - 1 个字符
  return str.slice(0, Math.max(0, maxLen - 1)) + '…';
}
