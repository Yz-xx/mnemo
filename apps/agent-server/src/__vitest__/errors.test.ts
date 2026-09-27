import { describe, expect, it } from 'vitest';
import { describeConnectionError } from '../errors.js';

describe('连接类错误翻译', () => {
  const target = 'ollama（http://127.0.0.1:11434，模型 qwen2.5:7b）';

  it('fetch failed 翻译为带服务名与目标地址的提示', () => {
    const result = describeConnectionError(new TypeError('fetch failed'), target, '对话模型服务');

    expect(result.message).toBe(`无法连接对话模型服务 ${target}，请确认该服务已启动后重试。`);
  });

  it('socket 错误码同样按连接失败处理', () => {
    const result = describeConnectionError(
      new Error('connect ECONNREFUSED 127.0.0.1:11434'),
      target,
      '向量化服务',
    );

    expect(result.message).toBe(`无法连接向量化服务 ${target}，请确认该服务已启动后重试。`);
  });

  it('非连接类错误原样返回，不替换文案', () => {
    const original = new Error('模型返回格式错误');

    expect(describeConnectionError(original, target, '对话模型服务')).toBe(original);
  });

  it('非 Error 抛出值包装为 Error 且保留原始内容', () => {
    const result = describeConnectionError({ code: 500 }, target, '对话模型服务');

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('[object Object]');
  });
});
