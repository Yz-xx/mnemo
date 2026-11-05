import { createLogger } from '@mnemo/logger';
import { createCoreResources } from './composition/resources.js';
import { createRuntime } from './composition/runtime.js';
import { startServer } from './composition/server.js';
import { loadConfig, SERVICE_NAME } from './configuration/config/index.js';
import { ensureSchema } from './infrastructure/db/schema/index.js';
import {
  createMetrics,
  METRIC,
  startEventLoopSampler,
} from './infrastructure/observability/index.js';
import { bootstrapSuperAdmin } from './services/admin/adminBootstrap.js';

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

/** 组合根：按「建库 → 建资源 → 建运行时 → 起服务」四段装配，细节分别见 composition/ 下各文件 */
async function bootstrap(): Promise<void> {
  // 首次启动时自动建库建表，随后复用同一个连接池
  await ensureSchema(config.postgres);
  const { resources, prunedSessions } = await createCoreResources(config, logger, metrics);
  const runtime = createRuntime(config, logger, metrics);

  // 超管自举：库中没有任何后台侧账号时建一枚，保证新库启动后立刻能进管理后台
  await bootstrapSuperAdmin(resources.users, config.initialAdmin, logger);
  // 启动恢复扫描：上次进程中断遗留的 processing 文档重新入队，回写时幂等重建片段
  await resources.knowledgeIngest.recover();

  startServer(
    { config, logger, metrics, ...resources, ...runtime },
    { prunedSessions, stopSampling: stopEventLoopSampler },
  );
}

bootstrap().catch((error: unknown) => {
  // 建库失败（如 PostgreSQL 未启动 / 密码错误）时直接退出，避免服务处于不可用状态
  logger.error('服务启动失败', { error });
  process.exitCode = 1;
});
