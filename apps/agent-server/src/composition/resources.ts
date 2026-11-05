import type { AppConfig } from '../configuration/config/index.js';
import type { MetricsRegistry } from '../infrastructure/observability/index.js';
import type { Logger } from '@mnemo/logger';
import {
  describeEmbeddingEndpoint,
  describeEmbeddingModel,
} from '../configuration/config/index.js';
import { createPasswordCipher } from '../infrastructure/auth/passwordCipher.js';
import { createCircuitBreaker } from '../infrastructure/concurrency/circuitBreaker.js';
import { createBoundedGate } from '../infrastructure/concurrency/gate.js';
import { createDbPool, createPgPool } from '../infrastructure/db/pool.js';
import { ApiLogStore } from '../mappers/apiLog/store.js';
import { AuditLogStore } from '../mappers/auditLog.js';
import { ConversationStore } from '../mappers/conversation/conversations.js';
import { FileStore } from '../mappers/file/fileStore.js';
import { KnowledgeBaseStore } from '../mappers/knowledge/bases.js';
import { PgVectorStore } from '../mappers/knowledge/pgStore.js';
import { SessionStore } from '../mappers/session.js';
import { UserStore } from '../mappers/user/store.js';
import { createKnowledgeIngest, KnowledgeStore } from '../services/knowledge/index.js';
import { AgentService } from '../services/llm/agent.js';
import { createEmbeddings } from '../services/llm/model.js';

/** 存储与业务服务：组合根的前半段产物，供路由层经 AppDependencies 取用 */
export interface CoreResources {
  pool: ReturnType<typeof createDbPool>;
  apiLogs: ApiLogStore;
  auditLogs: AuditLogStore;
  users: UserStore;
  sessions: SessionStore;
  passwordCipher: ReturnType<typeof createPasswordCipher>;
  conversations: ConversationStore;
  files: FileStore;
  knowledgeBases: KnowledgeBaseStore;
  knowledge: KnowledgeStore;
  knowledgeIngest: ReturnType<typeof createKnowledgeIngest>;
  agent: AgentService;
}

export interface CoreResourcesResult {
  resources: CoreResources;
  /** 启动时清理掉的过期 / 重复会话数，仅用于启动日志 */
  prunedSessions: number;
}

/**
 * 装配存储与业务服务：连接池 → 各 store → 知识库 → 对话服务 → 解析任务。
 * 抽取只为让组合根保持「建库 → 建资源 → 建运行时 → 起服务」四段的朗读顺序，
 * 构造细节仍集中在这里，不额外引入抽象层。
 */
export async function createCoreResources(
  config: AppConfig,
  logger: Logger,
  metrics: MetricsRegistry,
): Promise<CoreResourcesResult> {
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
  const knowledgeOptions = {
    chunkSize: config.knowledge.chunkSize,
    chunkOverlap: config.knowledge.chunkOverlap,
    topK: config.knowledge.topK,
    minScore: config.knowledge.minScore,
    embeddingModel: describeEmbeddingModel(config),
    embeddingEndpoint: describeEmbeddingEndpoint(config),
  };
  // 知识库 mapper：走主库连接池（库表在主 schema，与向量表分属两张池，见 docs/adr/0018 Consequences）
  const knowledgeBases = new KnowledgeBaseStore(pool);
  // 向量存储适配器：向量库与关系库共用同一 PG 实例，但另建一张池——
  // 向量库要按连接装载 hnsw 会话参数，与关系库池隔离才不会互相污染会话态（见 docs/adr/0012）
  const vectorStore = new PgVectorStore(createPgPool(config.postgres), knowledgeOptions);
  const knowledge = new KnowledgeStore(
    createEmbeddings(config),
    knowledgeOptions,
    vectorStore,
    // 库读取器：文档归属判定与检索过滤集的来源
    knowledgeBases,
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
  // 存量向量表补列：CREATE TABLE IF NOT EXISTS 不会给已有表加列，
  // 迭代 2 新增的文件列与解析状态列在此幂等补齐（启动恢复扫描要读 status，必须先于 recover）
  await vectorStore.ensureDocumentStore();
  // 视觉读取器用默认实现（第 4 参传 undefined 走默认值），日志与指标作为第 5、6 参注入
  const agent = new AgentService(config, knowledge, files, undefined, logger, metrics);
  // 异步解析任务：独立解析档闸门，大文件解析不与对话、上传争抢在途额度
  const knowledgeIngest = createKnowledgeIngest({
    knowledge,
    gate: createBoundedGate(config.concurrency.ingest, {
      logger,
      logContext: { gate: 'ingest' },
    }),
    logger,
    uploadDir: config.upload.dir,
  });

  return {
    resources: {
      pool,
      apiLogs,
      auditLogs,
      users,
      sessions,
      passwordCipher,
      conversations,
      files,
      knowledgeBases,
      knowledge,
      knowledgeIngest,
      agent,
    },
    prunedSessions,
  };
}
