/**
 * 批量接口的 ids 入参解析：去重后返回；缺省、空数组或含非法项一律返回 null，路由据此回 400。
 * 放在 routes 下而不入 services——它只收敛入参形状、不碰业务规则，
 * 与 pagination.ts 同属跨模块复用的纯工具。
 */
function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * 正整数 id 列表：用户 ID 用。
 * 只认 JSON 数字——`Number(item)` 会把 true 转成 1、把 [2] 转成 2，等于替调用方猜意图，
 * 与入参口径「含非法项一律 400」相悖。
 */
export function parseNumberIds(value: unknown): number[] | null {
  const raw = asArray(value);
  if (raw === null) return null;

  const ids = new Set<number>();
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) return null;
    ids.add(item);
  }
  return ids.size > 0 ? [...ids] : null;
}

/** 字符串 id 列表：文档 / 文件 / 会话 ID 用，只校验非空字符串，不改写原值 */
export function parseStringIds(value: unknown): string[] | null {
  const raw = asArray(value);
  if (raw === null) return null;

  const ids = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') return null;
    ids.add(item);
  }
  return ids.size > 0 ? [...ids] : null;
}
