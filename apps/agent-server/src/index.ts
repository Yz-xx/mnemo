import type { DbPool } from './db/pool.js';
import type { Logger } from '@repo/logger';
import { once } from 'node:events';
import http from 'node:http';
import { createLogger } from '@repo/logger';
import { createApp } from './app.js';
import { AuditLogStore } from './audit/store.js';
import { createPasswordCipher } from './auth/passwordCipher.js';
import { SessionStore } from './auth/sessionStore.js';
import { UserStore } from './auth/userStore/index.js';
import { createCircuitBreaker } from './concurrency/circuitBreaker.js';
import { createBoundedGate } from './concurrency/gate.js';
import {
  describeChatModel,
  describeEmbeddingEndpoint,
  describeEmbeddingModel,
  loadConfig,
  SERVICE_NAME,
} from './configuration/config/index.js';
import { createConversationLock } from './conversation/lock.js';
import { ConversationStore } from './conversation/store/index.js';
import { createDbPool } from './db/pool.js';
import { ensureSchema } from './db/schema/index.js';
import { FileStore } from './files/store/index.js';
import { AgentService } from './llm/agent.js';
import { createEmbeddings } from './llm/model.js';
import { ApiLogStore } from './logging/store.js';
import { createConcurrencyGuard } from './middleware/concurrencyGuard.js';
import { createMetrics, METRIC, startEventLoopSampler } from './observability/index.js';
import { KnowledgeStore } from './rag/index.js';

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

/**
 * 超管自举：仅当库中没有任何后台侧账号时创建一枚超管（已存在则原样跳过，不覆盖）。
 * 未配置凭据时告警而非静默跳过——否则新库部署完才发现没人能进管理后台（见 docs/adr/0006）。
 */
async function bootstrapSuperAdmin(
  users: UserStore,
  credentials: { username: string; password: string },
  logger: Logger,
): Promise<void> {
  if (!credentials.username || !credentials.password) {
    logger.warn('未配置初始超管凭据，跳过自举；库中若无后台账号将进不去管理后台', {
      hint: '需设置 INITIAL_ADMIN_USERNAME 与 INITIAL_ADMIN_PASSWORD',
    });
    return;
  }
  const result = await users.ensureSuperAdmin(credentials.username, credentials.password);
  if (result === 'created') {
    logger.info('已创建初始超级管理员', { username: credentials.username });
  } else if (result === 'username-taken') {
    logger.error('超管自举失败：用户名已被客户端账号占用', { username: credentials.username });
  }
}

/**
 * 运行期兜底与优雅停机。
 * - 崩溃：未捕获的异常与拒绝记一条日志后退出，交由进程守护重启，不让进程带着未知状态继续对外服务；
 * - 停机：先停止接单、断开空闲 keep-alive 连接，等在途请求收尾（超过宽限即强制断开），
 *   最后关闭数据库连接池、向量库连接并停止指标采样。停机因此比现在慢，等待上限由 SHUTDOWN_GRACE_MS 约定。
 */
function installShutdownHandlers(
  server: http.Server,
  pool: DbPool,
  knowledge: KnowledgeStore,
  apiLogs: ApiLogStore,
  stopSampling: () => void,
): void {
  let stopping = false;

  /** 优雅停机：置位后停止接单、等在途请求收尾，再关池并停采样；重复触发直接返回 */
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('开始优雅停机', { reason, graceMs: config.concurrency.shutdownGraceMs });
    server.close();
    server.closeIdleConnections();
    // 宽限到点仍未收尾的连接直接断开，避免停机无限期挂住
    const forceTimer = setTimeout(() => {
      logger.warn('停机宽限已到，强制断开剩余连接');
      server.closeAllConnections();
    }, config.concurrency.shutdownGraceMs);
    await once(server, 'close');
    clearTimeout(forceTimer);
    // 在途响应已收尾、finish 回调也已入队：此时刷空缓冲，确保停机前日志落尽
    await apiLogs.flush();
    // 再关掉对外连接并停止指标采样
    await pool.end();
    await knowledge.close();
    stopSampling();
    logger.info('已停机', { reason });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝，进程即将退出', { error: reason });
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常，进程即将退出', { error });
    process.exit(1);
  });
}

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
    config.dataDir,
    createEmbeddings(config),
    knowledgeOptions,
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
    // 适配器按配置开关选（见 docs/adr/0012）：VECTOR_STORE_PROVIDER 改回 lance 即回退本地库
    config.vectorStore,
    // 向量库与关系库共用同一 PG 实例，连接参数一并注入（pgvector 适配器据此另建自己的池）
    config.postgres,
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

  installShutdownHandlers(server, pool, knowledge, apiLogs, stopEventLoopSampler);
}

bootstrap().catch((error: unknown) => {
  // 建库失败（如 PostgreSQL 未启动 / 密码错误）时直接退出，避免服务处于不可用状态
  logger.error('服务启动失败', { error });
  process.exitCode = 1;
});
