import type { CircuitBreaker } from '../concurrency/circuitBreaker.js';
import type { BoundedGate } from '../concurrency/gate.js';
import type { MetricsRegistry } from '../observability/index.js';
import type { KnowledgeSearchResult } from './search.js';
import type { KnowledgeStorage, KnowledgeStoreOptions } from './storage.js';
import type { Logger } from '@repo/logger';
import { CircuitOpenError } from '../concurrency/circuitBreaker.js';
import { withTimeout } from '../concurrency/timeout.js';
import { METRIC } from '../observability/index.js';
import { CHUNKS_TABLE } from './lance.js';
import { visibilityFilter } from './search.js';

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

/** 检索主体：先按可见性过滤，再按余弦距离取前 topK 条 */
async function searchChunks(input: {
  storage: KnowledgeStorage;
  options: KnowledgeStoreOptions;
  governance?: RetrievalGovernance;
  query: string;
  userId: number;
  topK?: number;
}): Promise<KnowledgeSearchResult[]> {
  const { storage, options, governance, query, userId, topK } = input;
  const table = await storage.openExisting(CHUNKS_TABLE);
  if (!table || (await table.countRows()) === 0) return [];

  const vector = await callEmbedding(governance, () => storage.embedQuery(query));
  await storage.assertCompatible(vector.length);

  const rows = await table
    .query()
    .nearestTo(vector)
    .distanceType('cosine')
    .where(visibilityFilter(userId))
    .limit(topK ?? options.topK)
    .toArray();

  // 低于相似度下限的片段属于噪声，直接丢弃；过滤后条数可能少于 topK
  return rows
    .map((row) => ({
      documentId: String(row.document_id),
      title: String(row.title),
      content: String(row.content),
      score: 1 - Number(row._distance),
    }))
    .filter((item) => item.score >= options.minScore);
}

/**
 * 一次带治理的检索：过闸门 → 套超时 → 失败降级为「本轮无知识库结果」。
 * 返回空数组即本轮没有可用的知识库结果，调用方照常继续对话。
 */
export async function retrieveChunks(input: {
  storage: KnowledgeStorage;
  options: KnowledgeStoreOptions;
  governance?: RetrievalGovernance;
  query: string;
  userId: number;
  topK?: number;
}): Promise<KnowledgeSearchResult[]> {
  return (await runRetrieval(input.governance, () => searchChunks(input))) ?? [];
}
