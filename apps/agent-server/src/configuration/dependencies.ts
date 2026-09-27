import type { Logger } from '@repo/logger';
import type { SessionStore } from '../auth/sessionStore.js';
import type { UserStore } from '../auth/userStore.js';
import type { AppConfig } from './config.js';
import type { ConversationStore } from '../conversation/store.js';
import type { FileStore } from '../files/store.js';
import type { AgentService } from '../llm/agent.js';
import type { KnowledgeStore } from '../rag/store.js';

/**
 * 应用运行期依赖集合：由组合根 index.ts 统一装配后注入路由层。
 * 独立成文件，避免各路由反向依赖 app.ts 造成循环引用。
 */
export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  agent: AgentService;
  conversations: ConversationStore;
  files: FileStore;
  knowledge: KnowledgeStore;
  users: UserStore;
  sessions: SessionStore;
}
