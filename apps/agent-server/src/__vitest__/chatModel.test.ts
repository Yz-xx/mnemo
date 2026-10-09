import type { AppConfig } from '../configuration/config/index.js';
import { ChatOllama } from '@langchain/ollama';
import { describe, expect, it } from 'vitest';
import { createChatModel } from '../llm/model.js';

/** 只读 llm / ollama / deepseek 三段，其余字段给占位值即可 */
const CONFIG: AppConfig = {
  port: 3000,
  dataDir: 'tmp',
  log: { level: 'error', dir: 'tmp', retentionDays: 1 },
  mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'agent_data' },
  llm: {
    provider: 'ollama',
    temperature: 0.3,
    thinking: false,
    context: { windowTokens: 8192, triggerRatio: 0.7, keepRatio: 0.4, toolRatio: 0.3 },
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    chatModel: 'test-chat',
    embeddingModel: 'test-embedding',
    visionModel: '',
  },
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', chatModel: 'deepseek-chat' },
  embedding: { provider: 'ollama', apiKey: '', baseUrl: '', model: '' },
  knowledge: { chunkSize: 500, chunkOverlap: 80, topK: 4, minScore: 0.6, adminToken: '' },
  upload: { dir: 'tmp', maxBytes: 1024, maxFiles: 1, allowedTypes: ['png'] },
  initialAdmin: { username: '', password: '' },
};

/** 覆盖对话模型段：本组用例只关心 provider 与 thinking 两个开关 */
function withLlm(overrides: Partial<AppConfig['llm']>): AppConfig {
  return { ...CONFIG, llm: { ...CONFIG.llm, ...overrides } };
}

describe('createChatModel 的 thinking 开关', () => {
  it('开关关闭时向 Ollama 显式传 think=false，真正关掉推理链', () => {
    const model = createChatModel(CONFIG);

    expect(model).toBeInstanceOf(ChatOllama);
    // 必须显式传 false：省略 think 时 Ollama 对 thinking 模型（如 qwen3）等同开启
    expect((model as ChatOllama).think).toBe(false);
  });

  it('开关打开时向 Ollama 传 think=true，推理链才会随流下发', () => {
    const model = createChatModel(withLlm({ thinking: true }));

    expect((model as ChatOllama).think).toBe(true);
  });

  it('DeepSeek 分支不受该开关影响：走线上协议，不开本地 think', () => {
    const model = createChatModel(withLlm({ provider: 'deepseek', thinking: true }));

    expect(model).not.toBeInstanceOf(ChatOllama);
  });
});
