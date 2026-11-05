/** 路径参数：Express 5 的 params 值类型为 string | string[]，路径参数实际只有单值，这里收窄 */
export function pathParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 查询串里的关键词：非字符串按「不限」处理，首尾空白一律去掉 */
export function keywordParam(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
