import { describe, expect, it } from 'vitest';
import { toErrorMessage } from '../common.js';

describe('错误消息提取', () => {
  it('Error 取 message，非 Error 抛出值转为字符串', () => {
    expect(toErrorMessage(new Error('连接失败'))).toBe('连接失败');
    expect(toErrorMessage('字符串错误')).toBe('字符串错误');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });
});
