import type { AppConfig } from '../configuration/config/index.js';
import { describe, expect, it } from 'vitest';
import { describeHealth } from '../services/health.js';

/** 只填健康检查会读取的字段：本用例关注响应内容，不需要完整配置 */
function configWith(provider: 'ollama' | 'deepseek', model: string): AppConfig {
  return {
    llm: { provider },
    ollama: { chatModel: model },
    deepseek: { chatModel: model },
  } as unknown as AppConfig;
}

describe('describeHealth', () => {
  it('服务名与包名一致，不再出现旧代号 backend', () => {
    expect(describeHealth(configWith('ollama', 'qwen2.5:7b')).service).toBe('agent-server');
  });

  it('按当前提供方给出对话模型名与知识库状态，供客户端展示连接状态', () => {
    expect(describeHealth(configWith('deepseek', 'deepseek-chat'))).toMatchObject({
      status: 'ok',
      provider: 'deepseek',
      model: 'deepseek-chat',
      knowledgeEnabled: true,
    });
  });

  it('附带 ISO 时间戳，字段与规范约定的六项一一对应', () => {
    const now = new Date('2026-09-26T08:00:00.000Z');

    expect(Object.keys(describeHealth(configWith('ollama', 'qwen2.5:7b'), now)).sort()).toEqual([
      'knowledgeEnabled',
      'model',
      'provider',
      'service',
      'status',
      'timestamp',
    ]);
    expect(describeHealth(configWith('ollama', 'qwen2.5:7b'), now).timestamp).toBe(
      '2026-09-26T08:00:00.000Z',
    );
  });
});
