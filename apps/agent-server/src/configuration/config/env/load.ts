import type { AppConfig, LlmProvider } from './types.js';
import path from 'node:path';
import process from 'node:process';
import { readGate, toCount, toList, toLogLevel, toNumber, toRatio } from './parsers.js';

/** 读取运行配置：全部来自环境变量（可用 .env 文件提供），保证部署时无需改代码 */
export function loadConfig(): AppConfig {
  // 数据目录先解析出来，供知识库与日志目录共用同一基准
  const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  // 对话模型提供方先解析出来：上下文窗口预算与模型闸门水位都按它区分
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
    // 关系数据与知识库向量同库（见 docs/adr/0012 阶段 2）：两份配置合一，环境变量统一为 PG_*
    postgres: {
      host: process.env.PG_HOST ?? '127.0.0.1',
      port: toNumber(process.env.PG_PORT, 5432),
      user: process.env.PG_USER ?? 'postgres',
      // 默认留空而非写死常见弱口令：宁可连接失败，也不让误部署直接用上猜到的密码
      password: process.env.PG_PASSWORD ?? '',
      database: process.env.PG_DATABASE ?? 'postgres',
      // 池子不必大：读写都是短查询，池越大越容易把慢查询的影响面放大
      poolMax: toNumber(process.env.PG_POOL_MAX, 10),
      // 池满快速失败而非无限排队：默认给一段能排完的余量
      queueLimit: toCount(process.env.PG_QUEUE_LIMIT, 32),
      connectTimeoutMs: toNumber(process.env.PG_CONNECT_TIMEOUT_MS, 10000),
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
      // 模型闸门按 provider 分档：本地 Ollama 算力紧只放 1~2，线上 DeepSeek 可放宽（决策 9）
      model: readGate(
        'MODEL',
        provider === 'deepseek'
          ? { maxInFlight: 8, softLimit: 6, queueLimit: 32, queueTimeoutMs: 20000 }
          : { maxInFlight: 2, softLimit: 1, queueLimit: 8, queueTimeoutMs: 20000 },
      ),
      // 摘要闸门并发 1 且不排队：满即拒绝，由治理层退化为丢弃最老历史，不拖慢首 token（决策 10）
      summary: readGate('SUMMARY', {
        maxInFlight: 1,
        softLimit: 1,
        queueLimit: 0,
        queueTimeoutMs: 3000,
      }),
      // 检索闸门独立小并发：检索缺失只影响本轮答案质量，不阻断对话（决策 11）
      retrieval: readGate('RETRIEVAL', {
        maxInFlight: 4,
        softLimit: 2,
        queueLimit: 8,
        queueTimeoutMs: 3000,
      }),
      // 附件解析闸门：解析是主线程 CPU 密集计算，并发收到最小，排队只为削峰（决策 14）
      parse: readGate('PARSE', {
        maxInFlight: 2,
        softLimit: 1,
        queueLimit: 8,
        queueTimeoutMs: 5000,
      }),
      retrievalTimeoutMs: toNumber(process.env.RETRIEVAL_TIMEOUT_MS, 8000),
      // 熔断默认值：连续 5 次失败即快速失败 30 秒，之后放一个探测（决策 16）
      circuitFailureThreshold: toNumber(process.env.CIRCUIT_FAILURE_THRESHOLD, 5),
      circuitCooldownMs: toNumber(process.env.CIRCUIT_COOLDOWN_MS, 30000),
    },
    // 接口请求日志：攒批刷写替掉「每请求一条 INSERT」，把单轮基线压下来（见 docs/adr/0010 决策 13）
    apiLog: {
      batchSize: toNumber(process.env.API_LOG_BATCH_SIZE, 50),
      flushIntervalMs: toNumber(process.env.API_LOG_FLUSH_INTERVAL_MS, 1000),
    },
    // 鉴权会话缓存：短 TTL 压掉每请求一次 user_sessions 查询，登出等场景主动失效
    auth: {
      sessionCacheTtlMs: toNumber(process.env.AUTH_SESSION_CACHE_TTL_MS, 5000),
    },
    // 可观测与就绪检查（P4）：采样间隔与直方图窗口只影响观测分辨率，探测超时兜住就绪接口自身
    observability: {
      eventLoopSampleIntervalMs: toNumber(
        process.env.OBSERVABILITY_EVENT_LOOP_SAMPLE_INTERVAL_MS,
        10000,
      ),
      histogramSize: toNumber(process.env.OBSERVABILITY_HISTOGRAM_SIZE, 1024),
      readinessProbeTimeoutMs: toNumber(process.env.READINESS_PROBE_TIMEOUT_MS, 3000),
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
