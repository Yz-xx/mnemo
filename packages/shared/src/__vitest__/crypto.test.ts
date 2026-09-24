import { describe, expect, it } from 'vitest';
import { desDecrypt, desEncrypt } from '../crypto.js';

describe('DES 加解密', () => {
  it('加密结果可还原为原文', () => {
    const plain = 'BXZhuo@2026 密码 abc-123';
    expect(desDecrypt(desEncrypt(plain))).toBe(plain);
  });

  it('空字符串与长文本同样可还原', () => {
    const long = '知识库检索测试'.repeat(200);
    expect(desDecrypt(desEncrypt(''))).toBe('');
    expect(desDecrypt(desEncrypt(long))).toBe(long);
  });

  it('相同明文的密文保持稳定，可直接比对', () => {
    expect(desEncrypt('123456')).toBe(desEncrypt('123456'));
    expect(desEncrypt('123456')).not.toBe(desEncrypt('123457'));
  });

  it('密文不暴露明文，且被篡改后无法还原', () => {
    const cipher = desEncrypt('123456');
    const tampered = `${cipher.slice(0, -2)}AA`;

    expect(cipher).not.toContain('123456');
    expect(desDecrypt(tampered)).not.toBe('123456');
  });
});
