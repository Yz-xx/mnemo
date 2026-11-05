/** LLM 工具清单项：名称、用途与参数名，用于核对模型当前能用哪些能力 */
export interface AdminToolItem {
  name: string;
  description: string;
  params: string[];
}

/** 管理端系统配置：密钥类字段只给「是否已配置」，明文不出服务端 */
export interface AdminSystemConfig {
  port: number;
  dataDir: string;
  llm: {
    provider: string;
    model: string;
    endpoint: string;
    temperature: number;
    /** 仅线上提供方有此字段；本地 Ollama 不需要密钥 */
    apiKeyConfigured?: boolean;
  };
  embedding: {
    provider: string;
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
  log: {
    level: string;
    dir: string;
    retentionDays: number;
  };
  postgres: {
    host: string;
    port: number;
    user: string;
    database: string;
    passwordConfigured: boolean;
  };
}
