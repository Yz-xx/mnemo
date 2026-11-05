import type {
  ApiLogConfig,
  AuthConfig,
  HttpConfig,
  LogConfig,
  ObservabilityConfig,
  PostgresConfig,
} from '../types.js';
import path from 'node:path';
import process from 'node:process';
import { toCount, toLogLevel, toNumber } from '../parsers.js';

/** 日志：文件按天轮转，默认落在数据目录下的 logs */
export function loadLogConfig(dataDir: string): LogConfig {
  return {
    level: toLogLevel(process.env.LOG_LEVEL),
    dir: process.env.LOG_DIR ?? path.join(dataDir, 'logs'),
    retentionDays: toNumber(process.env.LOG_RETENTION_DAYS, 14),
  };
}

/** 关系数据与知识库向量同库（见 docs/adr/0012 阶段 2）：两份配置合一，环境变量统一为 PG_* */
export function loadPostgresConfig(): PostgresConfig {
  return {
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
  };
}

/** HTTP 超时只保证半死连接不永久占位，具体取值须由压测校准 */
export function loadHttpConfig(): HttpConfig {
  return {
    headersTimeoutMs: toNumber(process.env.HTTP_HEADERS_TIMEOUT_MS, 20000),
    // 需覆盖 20MB 上传的接收耗时，故给到 2 分钟
    requestTimeoutMs: toNumber(process.env.HTTP_REQUEST_TIMEOUT_MS, 120000),
    keepAliveTimeoutMs: toNumber(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 65000),
    maxRequestsPerSocket: toCount(process.env.HTTP_MAX_REQUESTS_PER_SOCKET, 1000),
  };
}

/** 接口请求日志：攒批刷写替掉「每请求一条 INSERT」，把单轮基线压下来（见 docs/adr/0010 决策 13） */
export function loadApiLogConfig(): ApiLogConfig {
  return {
    batchSize: toNumber(process.env.API_LOG_BATCH_SIZE, 50),
    flushIntervalMs: toNumber(process.env.API_LOG_FLUSH_INTERVAL_MS, 1000),
  };
}

/** 鉴权会话缓存：短 TTL 压掉每请求一次 user_sessions 查询，登出等场景主动失效 */
export function loadAuthConfig(): AuthConfig {
  return {
    sessionCacheTtlMs: toNumber(process.env.AUTH_SESSION_CACHE_TTL_MS, 5000),
  };
}

/** 可观测与就绪检查：采样间隔与直方图窗口只影响观测分辨率，探测超时兜住就绪接口自身 */
export function loadObservabilityConfig(): ObservabilityConfig {
  return {
    eventLoopSampleIntervalMs: toNumber(
      process.env.OBSERVABILITY_EVENT_LOOP_SAMPLE_INTERVAL_MS,
      10000,
    ),
    histogramSize: toNumber(process.env.OBSERVABILITY_HISTOGRAM_SIZE, 1024),
    readinessProbeTimeoutMs: toNumber(process.env.READINESS_PROBE_TIMEOUT_MS, 3000),
  };
}
