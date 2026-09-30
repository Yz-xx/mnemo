import type { ApiClient } from './http-client.js';
import { toBase64 } from '@repo/shared';

/** 服务端下发口令加密公钥的路径：两端共用同一约定，改路径只改这一处 */
const PUBLIC_KEY_PATH = '/api/auth/public-key';

/** 公钥响应体：字段名与 agent-server 的 /api/auth/public-key 一字不差，改动需两侧同步 */
interface PublicKeyResponse {
  publicKey: JsonWebKey;
}

/**
 * 用服务端公钥加密口令，返回 Base64 密文。登录、注册与新建用户的密码字段
 * 一律经此封装后再进请求体，明文不上网（见 docs/adr/0004）。
 *
 * 每次调用都重新取公钥：服务端密钥对随进程重建，缓存一份会让重启后的登录解不开。
 */
export async function encryptPassword(
  api: Pick<ApiClient, 'request'>,
  plain: string,
): Promise<string> {
  // WebCrypto 只在安全上下文可用（HTTPS 或 localhost）；取不到时宁可失败，也不回落到明文
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前访问方式不支持安全登录，请改用 HTTPS 打开');
  }

  const { publicKey } = await api.request<PublicKeyResponse>(PUBLIC_KEY_PATH);
  const key = await crypto.subtle.importKey(
    'jwk',
    publicKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const cipher = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    key,
    new TextEncoder().encode(plain),
  );
  return toBase64(new Uint8Array(cipher));
}
