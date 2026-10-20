import type { AppConfig } from './config/index.js';
import type { PasswordCipher } from '../infrastructure/auth/passwordCipher.js';
import type { ConversationLock } from '../infrastructure/concurrency/lock.js';
import type { DbPool } from '../infrastructure/db/pool.js';
import type { MetricsRegistry } from '../infrastructure/observability/index.js';
import type { ApiLogStore } from '../mappers/apiLog/store.js';
import type { AuditLogStore } from '../mappers/auditLog.js';
import type { ConversationStore } from '../mappers/conversation/conversations.js';
import type { FileStore } from '../mappers/file/fileStore.js';
import type { SessionStore } from '../mappers/session.js';
import type { UserStore } from '../mappers/user/store.js';
import type { ConcurrencyGuard } from '../middleware/concurrencyGuard.js';
import type { RoundRegistry } from '../services/conversation/roundRegistry.js';
import type { KnowledgeStore } from '../services/knowledge/index.js';
import type { AgentService } from '../services/llm/agent.js';
import type { Logger } from '@mnemo/logger';

/**
 * 应用运行期依赖集合：由组合根 index.ts 统一装配后注入路由层。
 * 独立成文件，避免各路由反向依赖 app.ts 造成循环引用。
 */
export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  /** 进程内指标注册表：各埋点方写入，就绪检查读取快照 */
  metrics: MetricsRegistry;
  /** 数据库连接池：就绪检查据此探测 PostgreSQL；池指标由 observability/poolMonitor 写入同一注册表 */
  pool: DbPool;
  agent: AgentService;
  /** 分档并发闸门：路由层按档取中间件挂载，过载以 503 拒绝 */
  guard: ConcurrencyGuard;
  /** 会话级串行锁：同一会话同刻只跑一轮，避免消息交错与摘要截断点竞争 */
  chatLock: ConversationLock;
  /** 接口请求日志：requestLog 中间件写入，管理端「API 日志」页读取 */
  apiLogs: ApiLogStore;
  /** 操作审计：adminAudit 中间件写入，管理端「操作审计」页读取 */
  auditLogs: AuditLogStore;
  conversations: ConversationStore;
  /** 在途轮次注册表：断点续传据此取轮次、停机据此中止全部（见 docs/adr/0015） */
  rounds: RoundRegistry;
  files: FileStore;
  knowledge: KnowledgeStore;
  users: UserStore;
  sessions: SessionStore;
  /** 口令传输加解密：公钥下发给客户端加密口令，私钥留在服务端解密 */
  passwordCipher: PasswordCipher;
}
