import type { AuditLogStore } from '../audit/store.js';
import type { PasswordCipher } from '../auth/passwordCipher.js';
import type { SessionStore } from '../auth/sessionStore.js';
import type { UserStore } from '../auth/userStore/index.js';
import type { ConversationLock } from '../conversation/lock.js';
import type { ConversationStore } from '../conversation/store/index.js';
import type { FileStore } from '../files/store.js';
import type { AgentService } from '../llm/agent.js';
import type { ApiLogStore } from '../logging/store.js';
import type { ConcurrencyGuard } from '../middleware/concurrencyGuard.js';
import type { KnowledgeStore } from '../rag/index.js';
import type { AppConfig } from './config/index.js';
import type { Logger } from '@repo/logger';

/**
 * 应用运行期依赖集合：由组合根 index.ts 统一装配后注入路由层。
 * 独立成文件，避免各路由反向依赖 app.ts 造成循环引用。
 */
export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
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
  files: FileStore;
  knowledge: KnowledgeStore;
  users: UserStore;
  sessions: SessionStore;
  /** 口令传输加解密：公钥下发给客户端加密口令，私钥留在服务端解密 */
  passwordCipher: PasswordCipher;
}
