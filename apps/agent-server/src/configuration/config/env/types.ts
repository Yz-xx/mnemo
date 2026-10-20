import type { LogLevel } from '@mnemo/logger';

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

/**
 * PostgreSQL 连接参数（见 docs/adr/0012）：关系数据与知识库向量同在一个实例，
 * 关系库池与向量库池共用这一份参数。
 */
export interface PostgresConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** 连接池上限：达到上限后的申请改为在应用侧排队 */
  poolMax: number;
  /**
   * 排队深度上限（见 docs/adr/0012 风险 2）：pg 的池本身会无界排队，而 ADR 0010 的 P0 生存线
   * 依赖「队满即拒绝」，故在应用侧补上这条与应用侧闸门同口径的排队上界
   */
  queueLimit: number;
  /** 建立单条连接的超时（毫秒）：PG 不可达时尽快失败 */
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
 * 入口的对话流 / 上传 / 普通读写三档，以及模型、摘要、检索、附件解析四道内部闸门，
 * 各持一份配置，配额互不挤占（见 docs/adr/0010 决策 3、5、9、10、11、14）。
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
  /** 对话模型闸门：真实瓶颈在模型算力，与入口的 HTTP 档闸门分开计量（见 docs/adr/0010 决策 9） */
  model: GateConfig;
  /** 滚动摘要闸门：独立低优先队列，不占对话额度；满即拒绝，由治理层降级（决策 10） */
  summary: GateConfig;
  /** 检索与向量化闸门：读路径过它，写入路径不占（决策 11） */
  retrieval: GateConfig;
  /** 单次检索（含向量化）超时（毫秒）：超时降级为「本轮无知识库结果」（决策 11） */
  retrievalTimeoutMs: number;
  /** 附件解析闸门：docx / xlsx / pdf 解析是主线程 CPU 密集计算，独占小额度（决策 14） */
  parse: GateConfig;
  /** 依赖熔断：连续失败达该值即快速失败（决策 16） */
  circuitFailureThreshold: number;
  /** 依赖熔断：打开后冷却多久再放一个探测（毫秒） */
  circuitCooldownMs: number;
  /** 已结束轮次的事件日志保留时长（毫秒）：期间允许客户端重连续传，过后即回收 */
  sseRoundTtlMs: number;
  /** 允许同时后台续生成的轮次上限：超过即中止最老的脱离轮次，防止无人回读的算力堆积 */
  sseDetachedMaxRounds: number;
  /** 单轮事件日志的帧数上限：超过即丢弃最老帧，兜住重放窗口与内存 */
  sseReplayMaxEvents: number;
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

/** 接口请求日志的批量刷写：攒批 + 定时，替掉「每请求一条 INSERT」 */
export interface ApiLogConfig {
  /** 缓冲达到该条数立即刷写 */
  batchSize: number;
  /** 未攒够该条数时的定时刷写间隔（毫秒） */
  flushIntervalMs: number;
}

/** 鉴权会话缓存：短 TTL 缓存令牌校验结果，压掉每请求一次 user_sessions 查询 */
export interface AuthConfig {
  /** 缓存有效期（毫秒）：登出 / 重新登录 / 删号会主动失效，这里只兜住被动变化（如会话过期） */
  sessionCacheTtlMs: number;
}

/**
 * 可观测与就绪检查（见 docs/adr/0010 决策 17）：采样口径与探测超时。
 * 这些值只影响观测的分辨率与开销，不参与放行判定，可随时调整。
 */
export interface ObservabilityConfig {
  /** 事件循环延迟采样间隔（毫秒）：越短越能捕捉短时阻塞，开销也越大 */
  eventLoopSampleIntervalMs: number;
  /** 直方图保留的最近样本数：分位数基于该窗口计算，长跑下内存仍有上界 */
  histogramSize: number;
  /** 就绪检查探测单个依赖的超时（毫秒） */
  readinessProbeTimeoutMs: number;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  log: LogConfig;
  /** 关系数据与知识库向量共用的 PostgreSQL 实例（见 docs/adr/0012 阶段 2） */
  postgres: PostgresConfig;
  /** HTTP 服务端超时与连接回收 */
  http: HttpConfig;
  /** 并发治理：分档闸门与过载兜底 */
  concurrency: ConcurrencyConfig;
  /** 接口请求日志批量刷写参数 */
  apiLog: ApiLogConfig;
  /** 鉴权会话缓存参数 */
  auth: AuthConfig;
  /** 可观测：事件循环采样、直方图窗口与就绪探测超时 */
  observability: ObservabilityConfig;
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
