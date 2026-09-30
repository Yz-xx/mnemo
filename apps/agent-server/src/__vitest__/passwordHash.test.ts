import { describe, expect, it } from 'vitest';
import { desEncrypt } from '@repo/shared/crypto';
import { hashPassword, verifyPassword } from '../auth/passwordHash.js';

describe('口令哈希', () => {
  it('入库串带 scrypt 前缀且不含明文', () => {
    const stored = hashPassword('secret123');

    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('secret123');
  });

  it('同一口令两次派生结果不同（盐随机）', () => {
    expect(hashPassword('secret123')).not.toBe(hashPassword('secret123'));
  });

  it('列宽内放得下：哈希串不超过 users.password 的 128 字符', () => {
    expect(hashPassword('a'.repeat(32)).length).toBeLessThanOrEqual(128);
  });

  it('正确口令通过校验，错误口令不通过', () => {
    const stored = hashPassword('secret123');

    expect(verifyPassword('secret123', stored)).toEqual({ ok: true, legacy: false });
    expect(verifyPassword('secret124', stored)).toEqual({ ok: false, legacy: false });
  });

  it('历史 DES 密文仍可校验通过，并标记为待升级', () => {
    const legacy = desEncrypt('secret123');

    expect(verifyPassword('secret123', legacy)).toEqual({ ok: true, legacy: true });
    expect(verifyPassword('secret124', legacy).ok).toBe(false);
  });

  it('哈希串被截断时不抛异常', () => {
    expect(verifyPassword('secret123', 'scrypt$abcd').ok).toBe(false);
  });
});
