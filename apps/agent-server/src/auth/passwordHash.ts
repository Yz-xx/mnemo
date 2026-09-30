import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { desEncrypt } from '@repo/shared/crypto';

/** 派生密钥长度与盐长度：取值同时兼顾强度与 users.password 的列宽（VARCHAR(128)） */
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
/** 存储格式前缀：历史数据是定值 DES 的 Base64（无前缀），据此区分两代口令 */
const PREFIX = 'scrypt';

/** 口令校验结果 */
export interface PasswordCheck {
  ok: boolean;
  /** 命中的是历史 DES 密文：此刻已拿到明文，调用方可就地改写为哈希 */
  legacy: boolean;
}

/** 把明文口令派生为 `scrypt$<盐hex>$<散列hex>`；盐随机，同一口令每次结果都不同 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  return `${PREFIX}$${salt.toString('hex')}$${scryptSync(plain, salt, KEY_LENGTH).toString('hex')}`;
}

/**
 * 校验口令。历史数据沿用定值 DES：那是可逆加密，没有任何强度可言，
 * 但直接改判会让存量账号全部登不进去，所以这里先照旧放行，并把 legacy 报给调用方，
 * 由调用方借这次拿到的明文把旧密文换成哈希（惰性升级）。
 */
export function verifyPassword(plain: string, stored: string): PasswordCheck {
  if (!stored.startsWith(`${PREFIX}$`)) {
    return { ok: stored === desEncrypt(plain), legacy: true };
  }
  const [prefix, saltHex, hashHex] = stored.split('$');
  if (prefix !== PREFIX || !saltHex || !hashHex) return { ok: false, legacy: false };

  const expected = Buffer.from(hashHex, 'hex');
  const derived = scryptSync(plain, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  // 长度不等时 timingSafeEqual 会抛错，先挡一道散列被截断之类的异常数据
  const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
  return { ok, legacy: false };
}
