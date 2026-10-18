import type { PasswordCipher } from '../../infrastructure/auth/passwordCipher.js';
import { describe, expect, it } from 'vitest';
import { parseCredentials } from '../../infrastructure/auth/credentials.js';

/** 替身：`enc:` 前缀视为可解密的密文，其余一律判为解不开（模拟密文被篡改） */
const cipher: PasswordCipher = {
  publicKey: () => ({ kty: 'RSA', n: 'n', e: 'AQAB' }),
  decrypt: (ciphertext) => (ciphertext.startsWith('enc:') ? ciphertext.slice(4) : null),
};

describe('凭证校验', () => {
  it('去除用户名首尾空格并解出密文里的口令', () => {
    const result = parseCredentials({ username: ' bxzhuo ', password: 'enc:123456' }, cipher);

    expect(result).toEqual({ ok: true, value: { username: 'bxzhuo', password: '123456' } });
  });

  it('用户名过短或含非法字符时给出提示', () => {
    expect(parseCredentials({ username: 'a', password: 'enc:123456' }, cipher).ok).toBe(false);
    expect(parseCredentials({ username: 'a b', password: 'enc:123456' }, cipher).ok).toBe(false);
  });

  it('密码长度不足或过长时给出提示', () => {
    expect(parseCredentials({ username: 'bxzhuo', password: 'enc:12345' }, cipher).ok).toBe(false);
    expect(
      parseCredentials({ username: 'bxzhuo', password: `enc:${'a'.repeat(33)}` }, cipher).ok,
    ).toBe(false);
  });

  it('明文或解不开的密文一律拒绝，不回落成按明文比对', () => {
    expect(parseCredentials({ username: 'bxzhuo', password: '123456' }, cipher).ok).toBe(false);
  });

  it('非字符串或缺失字段不会抛出异常', () => {
    expect(parseCredentials(undefined, cipher).ok).toBe(false);
    expect(parseCredentials({ username: 123, password: null }, cipher).ok).toBe(false);
  });
});
