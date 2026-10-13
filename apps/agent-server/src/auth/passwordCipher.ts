import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';

/**
 * 公钥的 JWK 表示：客户端 crypto.subtle.importKey 只读 kty / n / e，
 * 这里刻意收窄，避免把服务端密钥的其它元数据一并下发。
 */
export interface PublicKeyJwk {
  kty: string;
  n: string;
  e: string;
}

/** 口令传输的非对称加解密：客户端持公钥加密，服务端持私钥解密 */
export interface PasswordCipher {
  /** 下发给客户端的公钥（JWK），客户端在登录/注册前取回 */
  publicKey(): PublicKeyJwk;
  /** 解出请求体里以该公钥加密的 Base64 口令；解不开时返回 null */
  decrypt(ciphertext: string): string | null;
}

/** RSA 模长：2048 位下 OAEP-SHA256 单次最多承载 190 字节明文，口令远小于该上限 */
const MODULUS_LENGTH = 2048;

/**
 * 生成口令传输用的密钥对。密钥对随进程重建，既不落盘也不进配置：
 * 客户端每次登录前重新取公钥，轮换因此不需要任何失效处理；
 * 同时避免私钥被写进配置文件或镜像层——那些位置通常没有口令保护。
 */
export function createPasswordCipher(): PasswordCipher {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: MODULUS_LENGTH });
  const { kty, n, e } = publicKey.export({ format: 'jwk' }) as unknown as PublicKeyJwk;

  return {
    publicKey: () => ({ kty, n, e }),
    /** 解出用本进程公钥加密的 Base64 口令；解不开一律返回 null，不向调用方区分失败原因 */
    decrypt(ciphertext: string): string | null {
      try {
        const plain = privateDecrypt(
          { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(ciphertext, 'base64'),
        );
        return plain.toString('utf8');
      } catch {
        // 密文被截断、被改写或并非由本次公钥加密：一律按凭证非法处理，不向外区分原因
        return null;
      }
    },
  };
}
