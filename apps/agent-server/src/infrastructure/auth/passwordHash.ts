import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** 派生密钥长度与盐长度：取值同时兼顾强度与 users.password 的列宽（VARCHAR(128)） */
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
/** 存储格式前缀：本包产出的口令串以此开头，用作格式识别 */
const PREFIX = 'scrypt';

/** 把明文口令派生为 `scrypt$<盐hex>$<散列hex>`；盐随机，同一口令每次结果都不同 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  return `${PREFIX}$${salt.toString('hex')}$${scryptSync(plain, salt, KEY_LENGTH).toString('hex')}`;
}

/**
 * 校验口令。只认 `scrypt$<盐hex>$<散列hex>` 一种格式，不匹配即判为不通过。
 * 存量账号的 DES 密文兼容已在迁移完成后移除，取舍见 docs/adr/0004 的「后续变更」。
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const [prefix, saltHex, hashHex] = stored.split('$');
  if (prefix !== PREFIX || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = scryptSync(plain, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  // 长度不等时 timingSafeEqual 会抛错，先挡一道散列被截断之类的异常数据
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
