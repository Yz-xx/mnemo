import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../auth/passwordHash.js';

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

    expect(verifyPassword('secret123', stored)).toBe(true);
    expect(verifyPassword('secret124', stored)).toBe(false);
  });

  it('非 scrypt 格式的存量密文一律不通过（DES 兼容已移除）', () => {
    // 历史上此处是 DES 密文并会被放行；兼容分支删除后，任何非 scrypt$ 前缀的串都不再通过
    expect(verifyPassword('secret123', 'U2FsdGVkX18abcdef')).toBe(false);
  });

  it('哈希串被截断时不抛异常', () => {
    expect(verifyPassword('secret123', 'scrypt$abcd')).toBe(false);
  });
});
