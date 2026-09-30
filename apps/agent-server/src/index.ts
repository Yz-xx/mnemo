import { createLogger } from '@repo/logger';
import { createApp } from './app.js';
import { AuditLogStore } from './audit/store.js';
import { createPasswordCipher } from './auth/passwordCipher.js';
import { SessionStore } from './auth/sessionStore.js';
import { UserStore } from './auth/userStore.js';
import {
  describeChatModel,
  describeEmbeddingEndpoint,
  describeEmbeddingModel,
  loadConfig,
  SERVICE_NAME,
} from './configuration/config/index.js';
import { ConversationStore } from './conversation/store/index.js';
import { createMysqlPool } from './db/pool.js';
import { ensureSchema } from './db/schema.js';
import { FileStore } from './files/store.js';
import { AgentService } from './llm/agent.js';
import { createEmbeddings } from './llm/model.js';
import { ApiLogStore } from './logging/store.js';
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

/** 组合根：集中完成依赖装配，路由层只依赖抽象出来的实例 */
async function bootstrap(): Promise<void> {
  // 首次启动时自动建库建表，随后复用同一个连接池
  await ensureSchema(config.mysql);
  const pool = createMysqlPool(config.mysql);

  const apiLogs = new ApiLogStore(pool);
  const auditLogs = new AuditLogStore(pool);
  const users = new UserStore(pool);
  const sessions = new SessionStore(pool);
  // 口令传输密钥对：进程内生成、随重启轮换，不落盘（见 auth/passwordCipher.ts）
  const passwordCipher = createPasswordCipher();
  // 启动清理：清掉过期会话，并把历史遗留的同账号重复会话收敛为单端登录
  const prunedSessions = await sessions.prune();
  const conversations = new ConversationStore(pool);
  const files = new FileStore(pool, config.upload.dir);
  const knowledge = new KnowledgeStore(config.dataDir, createEmbeddings(config), {
    chunkSize: config.knowledge.chunkSize,
    chunkOverlap: config.knowledge.chunkOverlap,
    topK: config.knowledge.topK,
    minScore: config.knowledge.minScore,
    embeddingModel: describeEmbeddingModel(config),
    embeddingEndpoint: describeEmbeddingEndpoint(config),
  });
  const agent = new AgentService(config, knowledge, files);

  const app = createApp({
    config,
    logger,
    agent,
    apiLogs,
    auditLogs,
    conversations,
    files,
    knowledge,
    users,
    sessions,
    passwordCipher,
  });

  app.listen(config.port, () => {
    logger.info('智能体服务已启动', {
      url: `http://localhost:${config.port}`,
      chatModel: `${config.llm.provider} / ${describeChatModel(config)}`,
      embeddingModel: `${config.embedding.provider} / ${describeEmbeddingModel(config)}`,
      mysql: `${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`,
      dataDir: config.dataDir,
      uploadDir: config.upload.dir,
      logDir: config.log.dir,
      logLevel: config.log.level,
    });
    if (prunedSessions > 0) logger.info('已清理历史登录会话', { count: prunedSessions });
  });
}

bootstrap().catch((error: unknown) => {
  // 建库失败（如 MySQL 未启动 / 密码错误）时直接退出，避免服务处于不可用状态
  logger.error('服务启动失败', { error });
  process.exitCode = 1;
});
