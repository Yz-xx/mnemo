import type { AppConfig } from '../configuration/config/index.js';
import type { FileSource } from '../llm/tools/index.js';
import type { KnowledgeStore } from '../rag/index.js';
import { describe, expect, it } from 'vitest';
import { describeSystemConfig } from '../configuration/config/index.js';
import { createTools, describeTools } from '../llm/tools/index.js';
import { DISABLED_VISION } from '../llm/vision.js';

/** 组装工具只读这些依赖的构造参数，不调用它们：给空替身即可 */
const tools = createTools({} as KnowledgeStore, {} as FileSource, DISABLED_VISION);

/** 基准配置：密钥类字段一律填上可识别的明文，用于验证它们不会出现在响应里 */
function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    dataDir: 'D:/data',
    log: { level: 'info', dir: 'D:/data/logs', retentionDays: 14 },
    mysql: {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: 'mysql-secret',
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
      chatModel: 'qwen3',
      embeddingModel: 'nomic-embed-text',
      visionModel: 'qwen3-vl:8b',
    },
    deepseek: {
      apiKey: 'deepseek-secret',
      baseUrl: 'https://api.deepseek.com',
      chatModel: 'deepseek-chat',
    },
    embedding: {
      provider: 'ollama',
      apiKey: 'embedding-secret',
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
    },
    knowledge: {
      chunkSize: 500,
      chunkOverlap: 80,
      topK: 4,
      minScore: 0.6,
      adminToken: 'admin-secret',
    },
    upload: { dir: 'D:/data/uploads', maxBytes: 1024, maxFiles: 1, allowedTypes: ['pdf'] },
    initialAdmin: { username: 'root', password: 'admin-secret' },
    ...overrides,
  };
}

describe('LLM 工具清单', () => {
  it('清单来自工具定义本身，新增工具会自动出现', () => {
    const catalog = describeTools(tools);

    expect(catalog.map((item) => item.name)).toEqual([
      'search_knowledge_base',
      'list_files',
      'read_file',
      'write_file',
      'get_current_time',
      'calculator',
    ]);
    expect(catalog.every((item) => item.description.length > 0)).toBe(true);
  });

  it('参数名取自工具的 zod schema', () => {
    const catalog = describeTools(tools);

    expect(catalog.find((item) => item.name === 'write_file')?.params).toEqual([
      'name',
      'format',
      'content',
    ]);
    // 无参数工具的 schema 为空对象，不应被误报出参数
    expect(catalog.find((item) => item.name === 'get_current_time')?.params).toEqual([]);
  });
});

describe('管理端系统配置', () => {
  it('本地提供方不报密钥项，避免出现「未配置」的误导', () => {
    const view = describeSystemConfig(baseConfig());

    expect(view.llm.apiKeyConfigured).toBeUndefined();
    expect(view.embedding.apiKeyConfigured).toBeUndefined();
  });

  it('线上提供方按是否填了密钥回报', () => {
    const configured = describeSystemConfig(
      baseConfig({
        llm: {
          provider: 'deepseek',
          temperature: 0.3,
          thinking: false,
          context: { windowTokens: 8192, triggerRatio: 0.7, keepRatio: 0.4, toolRatio: 0.3 },
        },
        embedding: { ...baseConfig().embedding, provider: 'openai' },
      }),
    );
    expect(configured.llm.apiKeyConfigured).toBe(true);
    expect(configured.embedding.apiKeyConfigured).toBe(true);

    const missing = describeSystemConfig(
      baseConfig({
        llm: {
          provider: 'deepseek',
          temperature: 0.3,
          thinking: false,
          context: { windowTokens: 8192, triggerRatio: 0.7, keepRatio: 0.4, toolRatio: 0.3 },
        },
        deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', chatModel: 'deepseek-chat' },
      }),
    );
    expect(missing.llm.apiKeyConfigured).toBe(false);
  });

  it('密钥明文一律不出服务端，只留是否已配置', () => {
    const view = describeSystemConfig(baseConfig());
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain('secret');
    expect(view.mysql.passwordConfigured).toBe(true);
    expect(view.knowledge.adminTokenConfigured).toBe(true);
    // 非密钥项照常展示，后台要能核对实际参数
    expect(view.llm.model).toBe('qwen3');
    expect(view.mysql.database).toBe('agent_data');
  });

  it('未填的密钥按未配置回报', () => {
    const view = describeSystemConfig(
      baseConfig({
        mysql: { ...baseConfig().mysql, password: '' },
        knowledge: { ...baseConfig().knowledge, adminToken: '' },
      }),
    );

    expect(view.mysql.passwordConfigured).toBe(false);
    expect(view.knowledge.adminTokenConfigured).toBe(false);
  });
});
