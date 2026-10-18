/**
 * uuid 列的入口校验：PG 的 uuid 类型遇到非法字符串会直接抛 22P02（invalid input syntax），
 * 若不拦在入口，外部传入的乱码 ID 会把「查不到」变成 500（见 docs/adr/0012 边界风险）。
 * 只校验形状，不保证该 uuid 真实存在——存在性仍由查询结果决定。
 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 判断取值是否为标准 uuid 形状：会话 ID、文件 ID、登录令牌等 uuid 列的查询入口共用 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
