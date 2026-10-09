import type { AppConfig } from '../configuration/config/index.js';
import { ChatOllama } from '@langchain/ollama';
import { describe, expect, it } from 'vitest';
import { createChatModel } from '../llm/model.js';

/** 只读 llm / ollama / deepseek 三段，其余字段给占位值即可 */
const CONFIG: AppConfig = {
  port: 3000,
  dataDir: 'tmp',
  log: { level: 'error', dir: 'tmp', retentionDays: 1 },
  mysql: {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'agent_data',
    queueLimit: 32,
    connectTimeoutMs: 10000,
  },
  http: {
    headersTimeoutMs: 20000,
    requestTimeoutMs: 120000,
    keepAliveTimeoutMs: 65000,
    maxRequestsPerSocket: 1000,
  },
  concurrency: {
    chat: { maxInFlight: 8, softLimit: 6, queueLimit: 32, queueTimeoutMs: 20000 },
    upload: { maxInFlight: 2, softLimit: 1, queueLimit: 8, queueTimeoutMs: 10000 },
    crud: { maxInFlight: 32, softLimit: 24, queueLimit: 64, queueTimeoutMs: 5000 },
    chatMaxDurationMs: 180000,
    sseDrainTimeoutMs: 30000,
    shutdownGraceMs: 15000,
    model: { maxInFlight: 2, softLimit: 1, queueLimit: 8, queueTimeoutMs: 20000 },
    summary: { maxInFlight: 1, softLimit: 1, queueLimit: 0, queueTimeoutMs: 3000 },
    retrieval: { maxInFlight: 4, softLimit: 2, queueLimit: 8, queueTimeoutMs: 3000 },
    parse: { maxInFlight: 2, softLimit: 1, queueLimit: 8, queueTimeoutMs: 5000 },
    retrievalTimeoutMs: 8000,
    circuitFailureThreshold: 5,
    circuitCooldownMs: 30000,
  },
  apiLog: { batchSize: 50, flushIntervalMs: 1000 },
  auth: { sessionCacheTtlMs: 5000 },
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
