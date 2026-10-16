import type { KnowledgeStoreOptions, KnowledgeVectorStore } from './vectorStore.js';
import type { PostgresConfig, VectorStoreConfig } from '../configuration/config/index.js';
import { createPgPool } from '../db/pool.js';
import { LanceVectorStore } from './lanceStore.js';
import { PgVectorStore } from './pgStore.js';

/**
 * 按配置选向量存储适配器（见 docs/adr/0012 决策 9 / 阶段 3）。
 * 默认走 PostgreSQL + pgvector；只有显式配成 lance 才回退本地 LanceDB（回退路径保留一个迭代周期）。
 * 连接参数与关系库共用同一份（见阶段 2 决策 1），但另建一张池：
 * 向量库要按连接装载 hnsw 会话参数，与关系库池隔离才不会互相污染会话态。
 * dataDir 仅 LanceDB 适配器使用（库文件落盘位置）。
 */
export function createKnowledgeVectorStore(
  config: VectorStoreConfig | undefined,
  dataDir: string,
  options: KnowledgeStoreOptions,
  postgres?: PostgresConfig,
): KnowledgeVectorStore {
  if (config?.provider === 'lance') return new LanceVectorStore(dataDir, options);
  // 默认分支要 pgvector：缺连接参数属部署配置错误，宁可启动即失败也不要静默回路 LanceDB
  if (!postgres) {
    throw new Error(
      '向量存储默认为 pgvector，但未提供 PostgreSQL 连接参数；如需回退本地库请显式配 VECTOR_STORE_PROVIDER=lance',
    );
  }
  return new PgVectorStore(createPgPool(postgres), options);
}
