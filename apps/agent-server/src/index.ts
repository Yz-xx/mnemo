import http from 'node:http';
import { createLogger } from '@repo/logger';
import { createApp } from './app.js';
import {
  describeChatModel,
  describeEmbeddingEndpoint,
  describeEmbeddingModel,
  loadConfig,
  SERVICE_NAME,
} from './configuration/config/index.js';
import { createPasswordCipher } from './infrastructure/auth/passwordCipher.js';
import { createCircuitBreaker } from './infrastructure/concurrency/circuitBreaker.js';
import { createBoundedGate } from './infrastructure/concurrency/gate.js';
import { createConversationLock } from './infrastructure/concurrency/lock.js';
import { createDbPool, createPgPool } from './infrastructure/db/pool.js';
import { ensureSchema } from './infrastructure/db/schema/index.js';
import { installShutdownHandlers } from './infrastructure/lifecycle.js';
import {
  createMetrics,
  METRIC,
  startEventLoopSampler,
} from './infrastructure/observability/index.js';
import { ApiLogStore } from './mappers/apiLog/store.js';
import { AuditLogStore } from './mappers/auditLog.js';
import { ConversationStore } from './mappers/conversation/conversations.js';
import { FileStore } from './mappers/file/fileStore.js';
import { PgVectorStore } from './mappers/knowledge/pgStore.js';
import { SessionStore } from './mappers/session.js';
import { UserStore } from './mappers/user/store.js';
import { createConcurrencyGuard } from './middleware/concurrencyGuard.js';
import { bootstrapSuperAdmin } from './services/admin/adminBootstrap.js';
import { KnowledgeStore } from './services/knowledge/index.js';
import { AgentService } from './services/llm/agent.js';
import { createEmbeddings } from './services/llm/model.js';

// 配置与日志先于其它依赖建立：建库、连接池等启动环节失败时也能留下可排查的记录
const config = loadConfig();
const logger = createLogger({
  // 服务名：决定日志文件名前缀，便于同目录下区分多个服务
  name: SERVICE_NAME,
  level: config.log.level,
  dir: config.log.dir,
  retentionDays: config.log.retentionDays,
});

// 指标注册表：埋点方写入，就绪检查读取快照（见 docs/adr/0010 决策 17）
const metrics = createMetrics({ histogramSize: config.observability.histogramSize });
// 事件循环延迟按间隔采样写入注册表：定时器 unref，不阻止进程退出，停机时显式停采
const stopEventLoopSampler = startEventLoopSampler({
  intervalMs: config.observability.eventLoopSampleIntervalMs,
  onSample: (sample) => {
    metrics.gauge(METRIC.EVENT_LOOP_P50, sample.p50Ms);
    metrics.gauge(METRIC.EVENT_LOOP_P99, sample.p99Ms);
    metrics.gauge(METRIC.EVENT_LOOP_MAX, sample.maxMs);
  },
});

/** 组合根：集中完成依赖装配，路由层只依赖抽象出来的实例 */
async function bootstrap(): Promise<void> {
  // 首次启动时自动建库建表，随后复用同一个连接池
  await ensureSchema(config.postgres);
  // 应用侧池在 pg 池之上补「排队深度有界」：过载时以 503 快速失败（见 docs/adr/0012 风险 2）
  const pool = createDbPool(config.postgres, { metrics });

  // 接口日志改批量刷写：攒批 + 定时，替掉每请求一条 INSERT；失败告警收在 onError
  const apiLogs = new ApiLogStore(pool, {
    batchSize: config.apiLog.batchSize,
    flushIntervalMs: config.apiLog.flushIntervalMs,
    onError: (error) => logger.warn('接口日志批量落库失败', { error }),
  });
  const auditLogs = new AuditLogStore(pool);
  const users = new UserStore(pool);
  // 鉴权校验结果做短 TTL 缓存，压掉每请求一次 user_sessions 查询
  const sessions = new SessionStore(pool, config.auth.sessionCacheTtlMs);
  // 口令传输密钥对：进程内生成、随重启轮换，不落盘（见 auth/passwordCipher.ts）
  const passwordCipher = createPasswordCipher();
  // 启动清理：清掉过期会话，并把历史遗留的同账号重复会话收敛为单端登录
  const prunedSessions = await sessions.prune();
  const conversations = new ConversationStore(pool, metrics);
  const files = new FileStore(pool, config.upload.dir);
  // 知识库检索与向量化治理（见 docs/adr/0010 决策 11、16）：
  // 读路径过独立闸门并套超时、失败降级为空结果；向量服务连续失败即熔断，读写共用一份计数
  // 存储与切分参数先抽常量：构造处的参数位只剩依赖与开关，长对象字面量不再埋没关键项
  const knowledgeOptions = {
    chunkSize: config.knowledge.chunkSize,
    chunkOverlap: config.knowledge.chunkOverlap,
    topK: config.knowledge.topK,
    minScore: config.knowledge.minScore,
    embeddingModel: describeEmbeddingModel(config),
    embeddingEndpoint: describeEmbeddingEndpoint(config),
  };
  const knowledge = new KnowledgeStore(
    createEmbeddings(config),
    knowledgeOptions,
    // 向量存储适配器：向量库与关系库共用同一 PG 实例，但另建一张池——
    // 向量库要按连接装载 hnsw 会话参数，与关系库池隔离才不会互相污染会话态（见 docs/adr/0012）
    new PgVectorStore(createPgPool(config.postgres), knowledgeOptions),
    {
      gate: createBoundedGate(config.concurrency.retrieval, {
        logger,
        logContext: { gate: 'retrieval' },
      }),
      breaker: createCircuitBreaker({
        failureThreshold: config.concurrency.circuitFailureThreshold,
        cooldownMs: config.concurrency.circuitCooldownMs,
        label: '向量化服务',
        logger,
      }),
      timeoutMs: config.concurrency.retrievalTimeoutMs,
      metrics,
      logger,
    },
  );
  // 视觉读取器用默认实现（第 4 参传 undefined 走默认值），日志与指标作为第 5、6 参注入
  const agent = new AgentService(config, knowledge, files, undefined, logger, metrics);
  // 并发治理：分档闸门与会话级串行锁都是进程内状态，重启即清零（见 docs/adr/0010）
  const guard = createConcurrencyGuard(config.concurrency, logger);
  const chatLock = createConversationLock(config.concurrency.chat.queueTimeoutMs);

  // 超管自举：库中没有任何后台侧账号时建一枚，保证新库启动后立刻能进管理后台
  await bootstrapSuperAdmin(users, config.initialAdmin, logger);

  const app = createApp({
    config,
    logger,
    metrics,
    pool,
    agent,
    guard,
    chatLock,
    apiLogs,
    auditLogs,
    conversations,
    files,
    knowledge,
    users,
    sessions,
    passwordCipher,
  });

  // 显式建 HTTP 服务而非 app.listen：需要设超时与连接回收，拿不到 server 实例就设不了。
  // SSE 的响应期本不受 requestTimeout 约束，其长耗时由「单轮最长时长」兜底（见 docs/adr/0010 决策 6）
  const server = http.createServer(app);
  server.headersTimeout = config.http.headersTimeoutMs;
  server.requestTimeout = config.http.requestTimeoutMs;
  server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = config.http.maxRequestsPerSocket;

  server.listen(config.port, () => {
    logger.info('智能体服务已启动', {
      url: `http://localhost:${config.port}`,
      chatModel: `${config.llm.provider} / ${describeChatModel(config)}`,
      embeddingModel: `${config.embedding.provider} / ${describeEmbeddingModel(config)}`,
      postgres: `${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`,
      dataDir: config.dataDir,
      uploadDir: config.upload.dir,
      logDir: config.log.dir,
      logLevel: config.log.level,
    });
    if (prunedSessions > 0) logger.info('已清理历史登录会话', { count: prunedSessions });
  });

  installShutdownHandlers({
    server,
    flushApiLogs: () => apiLogs.flush(),
    closePool: () => pool.end(),
    closeKnowledge: () => knowledge.close(),
    stopSampling: stopEventLoopSampler,
    graceMs: config.concurrency.shutdownGraceMs,
    logger,
  });
}

bootstrap().catch((error: unknown) => {
  // 建库失败（如 PostgreSQL 未启动 / 密码错误）时直接退出，避免服务处于不可用状态
  logger.error('服务启动失败', { error });
  process.exitCode = 1;
});
