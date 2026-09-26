/** 用户名：2-32 位中文、字母、数字或下划线 */
const USERNAME_PATTERN = /^[\w\u4e00-\u9fa5]{2,32}$/;
/** 密码长度限制：与桌面端注册表单保持一致 */
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 32;

export interface Credentials {
  username: string;
  password: string;
}

export type CredentialsResult = { ok: true; value: Credentials } | { ok: false; message: string };

/** 校验并归一化登录/注册凭证，不合法时返回可直接展示给用户的提示 */
export function parseCredentials(input: unknown): CredentialsResult {
  const { username, password } = (input ?? {}) as { username?: unknown; password?: unknown };
  const name = typeof username === 'string' ? username.trim() : '';
  const secret = typeof password === 'string' ? password : '';

  if (!USERNAME_PATTERN.test(name)) {
    return { ok: false, message: '用户名需为 2-32 位中文、字母、数字或下划线' };
  }
  if (secret.length < PASSWORD_MIN_LENGTH || secret.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: `密码长度需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位` };
  }
  return { ok: true, value: { username: name, password: secret } };
}
