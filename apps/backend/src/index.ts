import { createApp } from './app.js';
import { SessionStore } from './auth/sessionStore.js';
import { UserStore } from './auth/userStore.js';
import { describeChatModel, loadConfig } from './config.js';
import { ConversationStore } from './conversation/store.js';
import { createMysqlPool } from './db/pool.js';
import { ensureSchema } from './db/schema.js';
import { AgentService } from './llm/agent.js';
import { createEmbeddings } from './llm/model.js';
import { KnowledgeStore } from './rag/store.js';

/** 组合根：集中完成依赖装配，路由层只依赖抽象出来的实例 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();

  // 首次启动时自动建库建表，随后复用同一个连接池
  await ensureSchema(config.mysql);
  const pool = createMysqlPool(config.mysql);

  const users = new UserStore(pool);
  const sessions = new SessionStore(pool);
  // 启动清理：清掉过期会话，并把历史遗留的同账号重复会话收敛为单端登录
  const prunedSessions = await sessions.prune();
  const conversations = new ConversationStore(pool);
  const knowledge = new KnowledgeStore(config.dataDir, createEmbeddings(config), config.knowledge);
  const agent = new AgentService(config, knowledge);

  const app = createApp({ config, agent, conversations, knowledge, users, sessions });

  app.listen(config.port, () => {
    console.log(`[backend] 智能体服务已启动: http://localhost:${config.port}`);
    console.log(`[backend] 对话模型: ${config.llm.provider} / ${describeChatModel(config)}`);
    console.log(`[backend] 向量模型: ${config.embedding.provider}`);
    console.log(`[backend] 数据目录: ${config.dataDir}`);
    console.log(
      `[backend] MySQL: ${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`,
    );
    if (prunedSessions > 0) {
      console.log(`[backend] 已清理历史登录会话 ${prunedSessions} 条`);
    }
  });
}

bootstrap().catch((error: unknown) => {
  // 建库失败（如 MySQL 未启动 / 密码错误）时直接退出，避免服务处于不可用状态
  console.error('[backend] 服务启动失败:', error);
  process.exitCode = 1;
});
