import type {
  KnowledgeStoreOptions,
  KnowledgeVectorStore,
} from '../../mappers/knowledge/vectorStore.js';
import type { RetrievalGovernance } from '../../services/knowledge/retrieval.js';
import type { Logger } from '@mnemo/logger';
import { describe, expect, it } from 'vitest';
import {
  CircuitOpenError,
  createCircuitBreaker,
} from '../../infrastructure/concurrency/circuitBreaker.js';
import { createBoundedGate } from '../../infrastructure/concurrency/gate.js';
import { createMetrics, METRIC } from '../../infrastructure/observability/index.js';
import { callEmbedding, retrieveChunks, runRetrieval } from '../../services/knowledge/retrieval.js';
import { FakeEmbeddings } from '../helpers/fakeEmbeddings.js';

/** 静默日志替身：降级与熔断开合都会记 warn，用例不关心日志内容 */
const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

/** 永久闭合的熔断器：只验证闸门与超时行为的用例用它把熔断隔离出去 */
const closedBreaker = () =>
  createCircuitBreaker({ failureThreshold: 5, cooldownMs: 1000, label: '向量化服务' });

/** 队列为 0 的闸门：占满后新申请立即被拒，便于构造「检索被闸门挡下」 */
const tightGate = () =>
  createBoundedGate({ maxInFlight: 1, softLimit: 1, queueLimit: 0, queueTimeoutMs: 1000 });

describe('runRetrieval 读路径降级', () => {
  it('闸门挡下时返回空结果，且不执行检索主体', async () => {
    const gate = tightGate();
    await gate.acquire();
    let called = false;

    const result = await runRetrieval(
      { gate, breaker: closedBreaker(), timeoutMs: 1000, logger },
      async () => {
        called = true;
        return ['命中'];
      },
    );

    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('检索超时时降级，不让挂死的依赖拖住整轮对话', async () => {
    const result = await runRetrieval(
      { gate: tightGate(), breaker: closedBreaker(), timeoutMs: 10, logger },
      () => new Promise<string[]>(() => undefined),
    );

    expect(result).toBeNull();
  });

  it('检索抛错时降级为空结果', async () => {
    const result = await runRetrieval(
      { gate: tightGate(), breaker: closedBreaker(), timeoutMs: 1000, logger },
      async () => {
        throw new Error('索引损坏');
      },
    );

    expect(result).toBeNull();
  });

  it('闸门额度用毕即归还，后续检索照常进行', async () => {
    const governance: RetrievalGovernance = {
      gate: tightGate(),
      breaker: closedBreaker(),
      timeoutMs: 1000,
      logger,
    };

    expect(await runRetrieval(governance, async () => ['命中'])).toEqual(['命中']);
    expect(await runRetrieval(governance, async () => ['命中'])).toEqual(['命中']);
  });

  it('不传治理时直通，便于本地脚本与单测', async () => {
    expect(await runRetrieval(undefined, async () => ['命中'])).toEqual(['命中']);
    expect(await callEmbedding(undefined, async () => 'ok')).toBe('ok');
  });
});

describe('callEmbedding 与熔断', () => {
  it('熔断打开时快速失败，写入路径据此如实报错而不是降级', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      label: '向量化服务',
    });
    breaker.onFailure();

    await expect(
      callEmbedding({ gate: tightGate(), breaker, timeoutMs: 1000 }, async () => [1]),
    ).rejects.toThrowError(CircuitOpenError);
  });

  it('失败回报给熔断器：连续失败达阈值即打开', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      label: '向量化服务',
      logger,
    });
    const governance: RetrievalGovernance = {
      gate: tightGate(),
      breaker,
      timeoutMs: 1000,
      logger,
    };
    const fail = async () => {
      throw new Error('连接失败');
    };

    await expect(callEmbedding(governance, fail)).rejects.toThrow('连接失败');
    await expect(callEmbedding(governance, fail)).rejects.toThrow('连接失败');

    expect(breaker.state()).toBe('open');
  });

  it('成功一次即清空失败计数，不把抖动当成故障', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      label: '向量化服务',
    });
    const governance: RetrievalGovernance = { gate: tightGate(), breaker, timeoutMs: 1000 };
    const fail = async () => {
      throw new Error('抖动');
    };

    await expect(callEmbedding(governance, fail)).rejects.toThrow();
    await callEmbedding(governance, async () => [0.1]);
    await expect(callEmbedding(governance, fail)).rejects.toThrow();

    expect(breaker.state()).toBe('closed');
  });
});

describe('retrieveChunks 召回条数埋点', () => {
  /** 检索参数：与线上同形，minScore 用于验证只统计过阈值的片段 */
  const options: KnowledgeStoreOptions = {
    chunkSize: 512,
    chunkOverlap: 64,
    topK: 4,
    minScore: 0.6,
    embeddingModel: 'fake',
    embeddingEndpoint: 'http://127.0.0.1:11434',
  };

  /** 检索替身：4 条命中里只有 2 条过 0.6 阈值 */
  const store = {
    countChunks: async () => 4,
    assertCompatible: async () => undefined,
    searchChunks: async () => [
      { documentId: 'd1', title: '文', content: '片段一', score: 0.91 },
      { documentId: 'd1', title: '文', content: '片段二', score: 0.7 },
      { documentId: 'd2', title: '文', content: '片段三', score: 0.55 },
      { documentId: 'd2', title: '文', content: '片段四', score: 0.12 },
    ],
  } as unknown as KnowledgeVectorStore;

  it('只把通过阈值的片段计入召回条数', async () => {
    const metrics = createMetrics();
    const result = await retrieveChunks({
      store,
      embeddings: new FakeEmbeddings(),
      options,
      governance: { gate: tightGate(), breaker: closedBreaker(), timeoutMs: 1000, metrics },
      query: '苹果',
      userId: 1,
    });

    expect(result).toHaveLength(2);
    expect(metrics.snapshot().counters[METRIC.RETRIEVAL_HITS]).toBe(2);
    // 同一份上下文里耗时也记了样本：两者相除即平均召回条数
    expect(metrics.snapshot().histograms[METRIC.RETRIEVAL]?.count).toBe(1);
  });

  it('零命中时计入 0，不把「检索无果」误记成一次命中', async () => {
    const metrics = createMetrics();
    const emptyStore = { ...store, searchChunks: async () => [] } as KnowledgeVectorStore;

    await retrieveChunks({
      store: emptyStore,
      embeddings: new FakeEmbeddings(),
      options,
      governance: { gate: tightGate(), breaker: closedBreaker(), timeoutMs: 1000, metrics },
      query: '苹果',
      userId: 1,
    });

    expect(metrics.snapshot().counters[METRIC.RETRIEVAL_HITS]).toBe(0);
  });
});
