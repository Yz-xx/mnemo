import type { KnowledgeSearchResult } from './search.js';
import type { KnowledgeStoreOptions, KnowledgeVectorStore } from './vectorStore.js';
import type { CircuitBreaker } from '../concurrency/circuitBreaker.js';
import type { BoundedGate } from '../concurrency/gate.js';
import type { MetricsRegistry } from '../observability/index.js';
import type { Embeddings } from '@langchain/core/embeddings';
import type { Logger } from '@repo/logger';
import { CircuitOpenError } from '../concurrency/circuitBreaker.js';
import { withTimeout } from '../concurrency/timeout.js';
import { describeConnectionError } from '../configuration/errors.js';
import { METRIC } from '../observability/index.js';

/**
 * 检索与向量化的治理接缝（见 docs/adr/0010 决策 11、16）：
 * - 向量服务熔断读写共用：依赖挂掉时快速失败，而不是把请求排满队逐个超时；
 * - 读路径（检索）过独立闸门并套超时，任何拒绝 / 超时 / 失败一律降级为「本轮无知识库结果」；
 * - 写入路径（入库 / 编辑）不降级：静默失败的知识库写入会污染库，必须如实报错。
 */
export interface RetrievalGovernance {
  /** 检索闸门：读路径过它；写入路径不占，写入要如实报错 */
  gate: BoundedGate;
  /** 向量服务熔断器：入库、编辑与检索共用一份计数 */
  breaker: CircuitBreaker;
  /** 单次检索（含向量化）超时（毫秒） */
  timeoutMs: number;
  /** 指标注册表：记录检索耗时；未注入时埋点短路 */
  metrics?: MetricsRegistry;
  logger?: Logger;
}

/**
 * 包一次向量服务调用：熔断打开即快速失败；成功与失败都回报给熔断器。
 * 读写两路共用——写入路径的异常照常抛给调用方，由上层出口转成用户可读的失败提示。
 */
export async function callEmbedding<T>(
  governance: RetrievalGovernance | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!governance) return task();
  const { breaker } = governance;
  if (!breaker.allow()) throw new CircuitOpenError('向量化服务');
  try {
    const result = await task();
    breaker.onSuccess();
    return result;
  } catch (error) {
    breaker.onFailure();
    throw error;
  }
}

/**
 * 按治理口径执行一次检索：过闸门 → 套超时。
 * 闸门拒绝、超时或检索失败都返回 null（降级为「本轮无知识库结果」）：
 * 检索缺失只影响本轮答案质量，不该把整轮对话拖失败。
 */
export async function runRetrieval<T>(
  governance: RetrievalGovernance | undefined,
  task: () => Promise<T>,
): Promise<T | null> {
  if (!governance) return task();
  const { gate, timeoutMs, metrics, logger } = governance;
  const outcome = await gate.acquire();
  if (outcome !== 'admitted') {
    logger?.warn('检索被闸门挡下，本轮按无知识库结果处理', { outcome });
    return null;
  }
  // 计时从入闸成功算起：闸门排队等待由闸门快照另行体现，避免把过载等待算进检索段
  const startedAt = Date.now();
  try {
    return await withTimeout(task(), timeoutMs, '知识库检索');
  } catch (error) {
    logger?.warn('检索失败或超时，本轮按无知识库结果处理', { error });
    return null;
  } finally {
    // 检索耗时含向量化与近邻查询，是「答案慢」与「知识库慢」的分界
    metrics?.observe(METRIC.RETRIEVAL, Date.now() - startedAt);
    gate.release();
  }
}

/** 向量化单个查询：连接类异常翻译成含服务地址的提示，与写入路径同一口径 */
async function embedQuery(
  embeddings: Embeddings,
  text: string,
  endpoint: string,
): Promise<number[]> {
  try {
    return await embeddings.embedQuery(text);
  } catch (error) {
    throw describeConnectionError(error, endpoint, '向量化服务');
  }
}

/** 检索主体：先按可见性预过滤，再按余弦距离取前 topK 条 */
async function searchChunks(input: {
  store: KnowledgeVectorStore;
  embeddings: Embeddings;
  options: KnowledgeStoreOptions;
  governance?: RetrievalGovernance;
  query: string;
  userId: number;
  topK?: number;
}): Promise<KnowledgeSearchResult[]> {
  const { store, embeddings, options, governance, query, userId, topK } = input;
  // 空库直接返回：省一次向量化，也避免把「库为空」报成向量服务故障
  if ((await store.countChunks()) === 0) return [];

  const vector = await callEmbedding(governance, () =>
    embedQuery(embeddings, query, options.embeddingEndpoint),
  );
  await store.assertCompatible(vector.length);

  const hits = await store.searchChunks(vector, { userId, topK: topK ?? options.topK });
  // 低于相似度下限的片段属于噪声，直接丢弃；过滤后条数可能少于 topK
  const kept = hits.filter((hit) => hit.score >= options.minScore);
  // 召回条数：与耗时同属治理上下文，用于回答「答非所问是知识库没命中还是模型没用上」
  governance?.metrics?.increment(METRIC.RETRIEVAL_HITS, kept.length);
  return kept;
}

/**
 * 一次带治理的检索：过闸门 → 套超时 → 失败降级为「本轮无知识库结果」。
 * 返回空数组即本轮没有可用的知识库结果，调用方照常继续对话。
 */
export async function retrieveChunks(input: {
  store: KnowledgeVectorStore;
  embeddings: Embeddings;
  options: KnowledgeStoreOptions;
  governance?: RetrievalGovernance;
  query: string;
  userId: number;
  topK?: number;
}): Promise<KnowledgeSearchResult[]> {
  return (await runRetrieval(input.governance, () => searchChunks(input))) ?? [];
}
