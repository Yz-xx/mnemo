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
  /** 池满后的等待队列长度上限：0 表示不排队（池满即失败），避免等待时间无界增长 */
  queueLimit: number;
  /** 建立单条连接的超时（毫秒）：MySQL 不可达时尽快失败，不让请求一直挂着 */
  connectTimeoutMs: number;
}

/** 上下文治理配置：窗口预算与触发比例，以及单轮工具结果的额度占比 */
export interface ContextConfig {
  /** 模型上下文窗口的 token 预算，按对话模型提供方取默认值 */
  windowTokens: number;
  /** 窗口占用超过该比例即触发治理 */
  triggerRatio: number;
  /** 触发后保留的窗口占比，恒不超过 triggerRatio */
  keepRatio: number;
  /** 单轮附件预读、检索、读取结果合计可注入的窗口占比：按窗口取值，避免每个提供方各配一个绝对数 */
  toolRatio: number;
}

/**
 * 单档闸门的水位与队列：软水位之上开始排队，硬水位之上直接拒绝。
 * 对话流 / 上传解析 / 普通读写三档各持一份，配额互不挤占（见 docs/adr/0010 决策 5）。
 */
export interface GateConfig {
  /** 硬水位（在途上限）：达到即拒绝，同时是放行的并发上限 */
  maxInFlight: number;
  /** 软水位：在途达到它后新请求改为排队，恒不大于 maxInFlight */
  softLimit: number;
  /** 队列长度上限：队列满即拒绝，保证等待时间有上界 */
  queueLimit: number;
  /** 排队等待上限（毫秒）：超时即拒绝 */
  queueTimeoutMs: number;
}

/** 并发治理配置：分档闸门水位，以及单轮时长、背压与停机宽限 */
export interface ConcurrencyConfig {
  /** 对话流档：单轮占用长，单独配额 */
  chat: GateConfig;
  /** 上传解析档：CPU 密集，单独配额 */
  upload: GateConfig;
  /** 普通读写档：会话 / 文件 / 知识库 / 管理端，配额较宽 */
  crud: GateConfig;
  /** 单轮对话最长时长（毫秒）：到点中断并按已产出收尾，防止半死连接永久占住额度 */
  chatMaxDurationMs: number;
  /** SSE 背压：写缓冲满后等待 drain 的上限（毫秒），超时按慢客户端断开 */
  sseDrainTimeoutMs: number;
  /** 优雅停机：停止接单后等待在途请求收尾的上限（毫秒） */
  shutdownGraceMs: number;
}

/** HTTP 层超时与连接回收：防止半死连接永久占用连接与额度 */
export interface HttpConfig {
  /** 请求头接收超时（毫秒） */
  headersTimeoutMs: number;
  /** 整个请求（头 + 体）接收超时（毫秒）；SSE 的响应期本就不受它约束 */
  requestTimeoutMs: number;
  /** keep-alive 空闲连接保持时长（毫秒） */
  keepAliveTimeoutMs: number;
  /** 单条连接可复用的最大请求数：0 表示不限 */
  maxRequestsPerSocket: number;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  log: LogConfig;
  mysql: MysqlConfig;
  /** HTTP 服务端超时与连接回收 */
  http: HttpConfig;
  /** 并发治理：分档闸门与过载兜底 */
  concurrency: ConcurrencyConfig;
  llm: {
    provider: LlmProvider;
    temperature: number;
    /** 是否让对话模型输出推理链（thinking）：默认关闭，仅对 Ollama 生效 */
    thinking: boolean;
    /** 上下文治理：决定每轮注入模型的历史是否裁剪、裁到多少 */
    context: ContextConfig;
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

/** 非负整数：0 有意义的计数用它（如队列长度上限 0 表示不排队），与只收正数的 toNumber 区分 */
function toCount(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 按档组装闸门：四项水位成套读取，缺省或非法时回落到该档默认值 */
function readGate(prefix: 'CHAT' | 'UPLOAD' | 'CRUD', fallback: GateConfig): GateConfig {
  const maxInFlight = toNumber(
    process.env[`CONCURRENCY_${prefix}_MAX_IN_FLIGHT`],
    fallback.maxInFlight,
  );
  const softLimit = toNumber(process.env[`CONCURRENCY_${prefix}_SOFT_LIMIT`], fallback.softLimit);
  return {
    maxInFlight,
    // 软水位不得高于硬水位：否则一进入排队就再也等不到放行
    softLimit: Math.min(softLimit, maxInFlight),
    queueLimit: toCount(process.env[`CONCURRENCY_${prefix}_QUEUE_LIMIT`], fallback.queueLimit),
    queueTimeoutMs: toNumber(
      process.env[`CONCURRENCY_${prefix}_QUEUE_TIMEOUT_MS`],
      fallback.queueTimeoutMs,
    ),
  };
}

/** 比例取值：限定在 (0, 1] 内，越界或非法一律退回默认值，避免配错把上下文整段裁空 */
function toRatio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

/** 日志级别：非法值一律退回 info，避免拼错环境变量导致日志全部静默 */
function toLogLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

/** 读取运行配置：全部来自环境变量（可用 .env 文件提供），保证部署时无需改代码 */
export function loadConfig(): AppConfig {
  // 数据目录先解析出来，供知识库与日志目录共用同一基准
  const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  // 对话模型提供方先解析出来：上下文窗口预算的默认值按它区分
  const provider: LlmProvider = process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'ollama';
  // 上下文比例先解析出来：保留比例要与触发比例比对，须在同一处算好
  const triggerRatio = toRatio(process.env.CONTEXT_TRIGGER_RATIO, 0.7);
  const keepRatio = toRatio(process.env.CONTEXT_KEEP_RATIO, 0.4);
  const toolRatio = toRatio(process.env.CONTEXT_TOOL_RATIO, 0.3);

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
      // 池满快速失败而非无限排队：默认给一段能排完的余量
      queueLimit: toCount(process.env.MYSQL_QUEUE_LIMIT, 32),
      connectTimeoutMs: toNumber(process.env.MYSQL_CONNECT_TIMEOUT_MS, 10000),
    },
    // HTTP 超时只保证半死连接不永久占位，具体取值须由 P4 压测校准
    http: {
      headersTimeoutMs: toNumber(process.env.HTTP_HEADERS_TIMEOUT_MS, 20000),
      // 需覆盖 20MB 上传的接收耗时，故给到 2 分钟
      requestTimeoutMs: toNumber(process.env.HTTP_REQUEST_TIMEOUT_MS, 120000),
      keepAliveTimeoutMs: toNumber(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 65000),
      maxRequestsPerSocket: toCount(process.env.HTTP_MAX_REQUESTS_PER_SOCKET, 1000),
    },
    // 并发治理默认值只保证不雪崩，吞吐基线须按容量模型压测后校准（见 docs/adr/0010）
    concurrency: {
      // 对话流：真实瓶颈在模型算力，档位收得最紧
      chat: readGate('CHAT', {
        maxInFlight: 8,
        softLimit: 6,
        queueLimit: 32,
        queueTimeoutMs: 20000,
      }),
      // 上传解析：CPU 密集且会阻塞事件循环，档位最紧
      upload: readGate('UPLOAD', {
        maxInFlight: 2,
        softLimit: 1,
        queueLimit: 8,
        queueTimeoutMs: 10000,
      }),
      // 普通读写：查询轻、往返多，给较宽上限
      crud: readGate('CRUD', {
        maxInFlight: 32,
        softLimit: 24,
        queueLimit: 64,
        queueTimeoutMs: 5000,
      }),
      chatMaxDurationMs: toNumber(process.env.CHAT_MAX_DURATION_MS, 180000),
      sseDrainTimeoutMs: toNumber(process.env.SSE_DRAIN_TIMEOUT_MS, 30000),
      shutdownGraceMs: toNumber(process.env.SHUTDOWN_GRACE_MS, 15000),
    },
    llm: {
      provider,
      temperature: toNumber(process.env.LLM_TEMPERATURE, 0.3),
      // 显式等于 true 才算开启：留空、拼错、写 1 都保持关闭，避免误开这条主链路变更
      thinking: process.env.LLM_THINKING === 'true',
      context: {
        // 窗口预算按提供方取：线上 DeepSeek 为 64K；本地 Ollama 保守取 8K，
        // 该值需与 Ollama 的 num_ctx 对齐，配大了估出的窗口会比模型实际能吃下的宽
        windowTokens: toNumber(
          provider === 'deepseek'
            ? process.env.DEEPSEEK_CONTEXT_WINDOW_TOKENS
            : process.env.OLLAMA_CONTEXT_WINDOW_TOKENS,
          provider === 'deepseek' ? 65536 : 8192,
        ),
        triggerRatio,
        // 保留比例不得超过触发比例：否则触发后仍丢不掉任何一轮，等于没裁
        keepRatio: Math.min(keepRatio, triggerRatio),
        toolRatio,
      },
    },
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen3',
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
