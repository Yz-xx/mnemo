/**
 * 对称加解密工具（DES）
 */
import CryptoJS from 'crypto-js';

/** DES 分组密钥固定为 8 字节，密钥文本不足时以 0 补齐 */
const DES_KEY = CryptoJS.enc.Utf8.parse('@bxzhuo'.padEnd(8, '\0'));

/**
 * ECB 模式 + PKCS7 填充：同一明文每次加密结果一致，
 * 因此可直接用密文比对来校验（如密码校验），无需先解密。
 */
const DES_OPTIONS = { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 };

/** DES 加密，返回 Base64 编码的密文 */
export function desEncrypt(plain: string): string {
  const { ciphertext } = CryptoJS.DES.encrypt(CryptoJS.enc.Utf8.parse(plain), DES_KEY, DES_OPTIONS);
  return CryptoJS.enc.Base64.stringify(ciphertext);
}

/** DES 解密；密文非法或密钥不匹配时返回空字符串 */
export function desDecrypt(cipher: string): string {
  try {
    const cipherParams = CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Base64.parse(cipher),
    });
    return CryptoJS.DES.decrypt(cipherParams, DES_KEY, DES_OPTIONS).toString(CryptoJS.enc.Utf8);
  } catch {
    return '';
  }
}
