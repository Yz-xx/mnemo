import { createApp } from './app.js';
import { describeChatModel, loadConfig } from './config.js';
import { ConversationStore } from './conversation/store.js';
import { AgentService } from './llm/agent.js';
import { createEmbeddings } from './llm/model.js';
import { KnowledgeStore } from './rag/store.js';

const config = loadConfig();

// 组合根：集中完成依赖装配，路由层只依赖抽象出来的实例
const conversations = new ConversationStore(config.dataDir);
const knowledge = new KnowledgeStore(config.dataDir, createEmbeddings(config), config.knowledge);
const agent = new AgentService(config, knowledge);

const app = createApp({ config, agent, conversations, knowledge });

app.listen(config.port, () => {
  console.log(`[backend] 智能体服务已启动: http://localhost:${config.port}`);
  console.log(`[backend] 对话模型: ${config.llm.provider} / ${describeChatModel(config)}`);
  console.log(`[backend] 向量模型: ${config.embedding.provider}`);
  console.log(`[backend] 数据目录: ${config.dataDir}`);
});
