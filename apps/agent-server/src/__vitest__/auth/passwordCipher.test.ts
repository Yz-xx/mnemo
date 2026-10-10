import { describe, expect, it } from 'vitest';
import { createPasswordCipher } from '../../auth/passwordCipher.js';

describe('口令传输密文', () => {
  const cipher = createPasswordCipher();

  it('公钥只下发 kty / n / e，不夹带私钥或其它元数据', () => {
    expect(Object.keys(cipher.publicKey()).sort()).toEqual(['e', 'kty', 'n']);
  });

  it('非 Base64 的串解不开时返回 null，而不是抛异常', () => {
    expect(cipher.decrypt('not-a-cipher')).toBeNull();
  });

  it('Base64 合法但并非本公钥所加密的串同样返回 null', () => {
    expect(cipher.decrypt(Buffer.from('random-bytes-here').toString('base64'))).toBeNull();
  });

  it('每次生成的密钥对不同（进程重建即轮换）', () => {
    expect(createPasswordCipher().publicKey().n).not.toBe(cipher.publicKey().n);
  });
});
