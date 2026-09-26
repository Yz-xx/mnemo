import { describe, expect, it } from 'vitest';
import { parseCredentials } from '../auth/credentials.js';

describe('凭证校验', () => {
  it('去除用户名首尾空格并透传密码', () => {
    const result = parseCredentials({ username: ' bxzhuo ', password: '123456' });

    expect(result).toEqual({ ok: true, value: { username: 'bxzhuo', password: '123456' } });
  });

  it('用户名过短或含非法字符时给出提示', () => {
    expect(parseCredentials({ username: 'a', password: '123456' }).ok).toBe(false);
    expect(parseCredentials({ username: 'a b', password: '123456' }).ok).toBe(false);
  });

  it('密码长度不足或过长时给出提示', () => {
    expect(parseCredentials({ username: 'bxzhuo', password: '12345' }).ok).toBe(false);
    expect(parseCredentials({ username: 'bxzhuo', password: 'a'.repeat(33) }).ok).toBe(false);
  });

  it('非字符串或缺失字段不会抛出异常', () => {
    expect(parseCredentials(undefined).ok).toBe(false);
    expect(parseCredentials({ username: 123, password: null }).ok).toBe(false);
  });
});
