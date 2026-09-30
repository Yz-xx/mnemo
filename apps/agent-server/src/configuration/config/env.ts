import type { LogLevel } from '@repo/logger';
import path from 'node:path';
import process from 'node:process';

/** 服务标识：日志文件名前缀与健康检查的 service 字段共用，改名时只需改这一处 */
export const SERVICE_NAME = 'agent-server';

/** 对话模型提供方：本地 Ollama 或 OpenAI 兼容的线上服务（DeepSeek） */
export type LlmProvider = 'ollama' | 'deepseek';

/** 向量化提供方：DeepSeek 不提供 embedding 接口，故与对话模型独立配置 */
export type EmbeddingProvider = 'ollama' | 'openai';

/** 日志配置：文件按天轮转，级别用于过滤调试信息 */
export interface LogConfig {
  level: LogLevel;
  /** 日志目录，默认落在数据目录下的 logs */
  dir: string;
  /** 日志文件保留天数 */
  retentionDays: number;
}

/** MySQL 连接参数：用户与对话记录持久化在此库中 */
export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  log: LogConfig;
  mysql: MysqlConfig;
  llm: {
    provider: LlmProvider;
    temperature: number;
  };
  ollama: {
    baseUrl: string;
    chatModel: string;
    embeddingModel: string;
    /** 视觉模型：用于理解图片附件；留空表示关闭图片理解 */
    visionModel: string;
  };
  deepseek: {
    apiKey: string;
    baseUrl: string;
    chatModel: string;
  };
  embedding: {
    provider: EmbeddingProvider;
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  knowledge: {
    chunkSize: number;
    chunkOverlap: number;
    topK: number;
    /** 检索相似度下限：低于该分数的片段视为噪声丢弃 */
    minScore: number;
    /** 全局知识库管理令牌；留空表示不开放全局文档写入接口 */
    adminToken: string;
  };
  upload: {
    /** 落盘根目录；路径类配置一律绝对路径，默认落在数据目录下 */
    dir: string;
    /** 单文件字节上限 */
    maxBytes: number;
    /** 单请求文件数上限 */
    maxFiles: number;
    /** 允许的扩展名白名单：与 magic bytes 判定结果比对，不看客户端给的扩展名 */
    allowedTypes: string[];
  };
  /** 初始超管凭据：仅当库中没有任何后台侧账号时用它自举，留空即跳过并告警 */
  initialAdmin: {
    username: string;
    password: string;
  };
}

/** 逗号分隔列表：去空白、统一小写、去重，避免大小写或多余空格让白名单静默失效 */
function toList(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) return fallback;
  const items = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(items)];
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 日志级别：非法值一律退回 info，避免拼错环境变量导致日志全部静默 */
function toLogLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

/** 读取运行配置：全部来自环境变量（可用 .env 文件提供），保证部署时无需改代码 */
export function loadConfig(): AppConfig {
  // 数据目录先解析出来，供知识库与日志目录共用同一基准
  const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');

  return {
    port: toNumber(process.env.PORT, 3000),
    dataDir,
    log: {
      level: toLogLevel(process.env.LOG_LEVEL),
      dir: process.env.LOG_DIR ?? path.join(dataDir, 'logs'),
      retentionDays: toNumber(process.env.LOG_RETENTION_DAYS, 14),
    },
    mysql: {
      host: process.env.MYSQL_HOST ?? '127.0.0.1',
      port: toNumber(process.env.MYSQL_PORT, 3306),
      user: process.env.MYSQL_USER ?? 'root',
      // 默认留空而非写死常见弱口令：宁可连接失败，也不让误部署直接用上猜到的密码
      password: process.env.MYSQL_PASSWORD ?? '',
      database: process.env.MYSQL_DATABASE ?? 'agent_data',
    },
    llm: {
      provider: process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'ollama',
      temperature: toNumber(process.env.LLM_TEMPERATURE, 0.3),
    },
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen2.5:7b',
      embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
      // 默认指向本机已装的视觉模型；置空字符串即关闭图片理解
      visionModel: process.env.OLLAMA_VISION_MODEL ?? 'qwen3-vl:8b',
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      chatModel: process.env.DEEPSEEK_CHAT_MODEL ?? 'deepseek-chat',
    },
    embedding: {
      provider: process.env.EMBEDDING_PROVIDER === 'openai' ? 'openai' : 'ollama',
      apiKey: process.env.EMBEDDING_API_KEY ?? '',
      baseUrl: process.env.EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
    },
    knowledge: {
      chunkSize: toNumber(process.env.KNOWLEDGE_CHUNK_SIZE, 500),
      chunkOverlap: toNumber(process.env.KNOWLEDGE_CHUNK_OVERLAP, 80),
      topK: toNumber(process.env.KNOWLEDGE_TOP_K, 4),
      minScore: toNumber(process.env.KNOWLEDGE_MIN_SCORE, 0.6),
      adminToken: process.env.KNOWLEDGE_ADMIN_TOKEN ?? '',
    },
    upload: {
      dir: process.env.UPLOAD_DIR ?? path.join(dataDir, 'uploads'),
      maxBytes: toNumber(process.env.UPLOAD_MAX_BYTES, 20 * 1024 * 1024),
      maxFiles: toNumber(process.env.UPLOAD_MAX_FILES, 1),
      allowedTypes: toList(process.env.UPLOAD_ALLOWED_TYPES, ['docx', 'xlsx', 'pdf', 'png', 'jpg']),
    },
    initialAdmin: {
      username: process.env.INITIAL_ADMIN_USERNAME ?? '',
      password: process.env.INITIAL_ADMIN_PASSWORD ?? '',
    },
  };
}
