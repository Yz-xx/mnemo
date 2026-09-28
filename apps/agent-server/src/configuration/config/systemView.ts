import type { AppConfig, EmbeddingProvider, LlmProvider, LogConfig } from './env.js';

/** 当前对话模型名称，用于健康检查与界面展示 */
export function describeChatModel(config: AppConfig): string {
  return config.llm.provider === 'deepseek' ? config.deepseek.chatModel : config.ollama.chatModel;
}

/** 当前对话模型服务地址，用于把连接失败翻译成可定位的提示 */
export function describeChatEndpoint(config: AppConfig): string {
  return config.llm.provider === 'deepseek' ? config.deepseek.baseUrl : config.ollama.baseUrl;
}

/** 当前向量模型名称，用于识别知识库是否由同一模型建立 */
export function describeEmbeddingModel(config: AppConfig): string {
  return config.embedding.provider === 'openai'
    ? config.embedding.model
    : config.ollama.embeddingModel;
}

/** 当前向量化服务地址，用于把连接失败翻译成可定位的提示 */
export function describeEmbeddingEndpoint(config: AppConfig): string {
  return config.embedding.provider === 'openai' ? config.embedding.baseUrl : config.ollama.baseUrl;
}

/**
 * 管理端系统配置视图：运维在后台核对运行参数用。
 * 密钥类配置（模型 API Key、MySQL 密码、知识库管理令牌）一律只回「是否已配置」，
 * 明文不出服务端——后台是只读展示，没有把密钥摆回页面上的必要。
 */
export interface AdminSystemConfig {
  port: number;
  dataDir: string;
  llm: {
    provider: LlmProvider;
    model: string;
    endpoint: string;
    temperature: number;
    /** 仅线上提供方需要密钥，本地 Ollama 不报这项 */
    apiKeyConfigured?: boolean;
  };
  embedding: {
    provider: EmbeddingProvider;
    model: string;
    endpoint: string;
    apiKeyConfigured?: boolean;
  };
  knowledge: {
    chunkSize: number;
    chunkOverlap: number;
    topK: number;
    minScore: number;
    adminTokenConfigured: boolean;
  };
  upload: {
    dir: string;
    maxBytes: number;
    maxFiles: number;
    allowedTypes: string[];
  };
  log: LogConfig;
  mysql: {
    host: string;
    port: number;
    user: string;
    database: string;
    passwordConfigured: boolean;
  };
}

/** 组装管理端系统配置视图：字段全部取自 AppConfig，不额外引入运行期状态，便于直接断言 */
export function describeSystemConfig(config: AppConfig): AdminSystemConfig {
  return {
    port: config.port,
    dataDir: config.dataDir,
    llm: {
      provider: config.llm.provider,
      model: describeChatModel(config),
      endpoint: describeChatEndpoint(config),
      temperature: config.llm.temperature,
      ...(config.llm.provider === 'deepseek'
        ? { apiKeyConfigured: config.deepseek.apiKey !== '' }
        : {}),
    },
    embedding: {
      provider: config.embedding.provider,
      model: describeEmbeddingModel(config),
      endpoint: describeEmbeddingEndpoint(config),
      ...(config.embedding.provider === 'openai'
        ? { apiKeyConfigured: config.embedding.apiKey !== '' }
        : {}),
    },
    knowledge: {
      chunkSize: config.knowledge.chunkSize,
      chunkOverlap: config.knowledge.chunkOverlap,
      topK: config.knowledge.topK,
      minScore: config.knowledge.minScore,
      adminTokenConfigured: config.knowledge.adminToken !== '',
    },
    upload: {
      dir: config.upload.dir,
      maxBytes: config.upload.maxBytes,
      maxFiles: config.upload.maxFiles,
      allowedTypes: config.upload.allowedTypes,
    },
    log: config.log,
    mysql: {
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      database: config.mysql.database,
      passwordConfigured: config.mysql.password !== '',
    },
  };
}
