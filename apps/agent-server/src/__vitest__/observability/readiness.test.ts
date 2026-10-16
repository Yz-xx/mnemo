import type { AppConfig } from '../../configuration/config/index.js';
import type { DbPool } from '../../db/pool.js';
import type { ConcurrencyGuard } from '../../middleware/concurrencyGuard.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../../observability/index.js';
import { describeReadiness } from '../../services/readiness.js';

/** 只填就绪检查会读取的字段：用例关注探测分支，不需要完整配置 */
function configWith(input: {
  chat: 'ollama' | 'deepseek';
  embedding: 'ollama' | 'openai';
}): AppConfig {
  return {
    llm: { provider: input.chat },
    ollama: {
      chatModel: 'qwen3',
      embeddingModel: 'nomic-embed-text',
      baseUrl: 'http://127.0.0.1:11434',
    },
    deepseek: { chatModel: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
    embedding: {
      provider: input.embedding,
      model: 'text-embedding-3-small',
      baseUrl: 'https://api.openai.com/v1',
    },
    observability: { readinessProbeTimeoutMs: 50 },
  } as unknown as AppConfig;
}

/** 可用的假连接池：SELECT 1 正常返回 */
function healthyPool(): DbPool {
  return { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as DbPool;
}

/** 假闸门：就绪检查只读它的快照 */
function fakeGuard(): ConcurrencyGuard {
  return {
    snapshot: () => [
      { tier: 'chat', inFlight: 1, queued: 0, rejected: 0, maxInFlight: 8, queueLimit: 32 },
    ],
  } as unknown as ConcurrencyGuard;
}

/** 可达响应：只探测连通性，故只需可取消的 body */
const reachable = (): { body: { cancel: () => void } } => ({ body: { cancel: () => undefined } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('describeReadiness', () => {
  it('三项依赖都可达即 ready，并汇总闸门水位与指标快照', async () => {
    const metrics = createMetrics();
    metrics.increment('gate.rejected', 2);
    const fetchMock = vi.fn(async () => reachable());
    vi.stubGlobal('fetch', fetchMock);
    const guard = fakeGuard();

    const payload = await describeReadiness({
      config: configWith({ chat: 'ollama', embedding: 'ollama' }),
      pool: healthyPool(),
      guard,
      metrics,
      now: new Date('2026-10-09T00:00:00.000Z'),
    });

    expect(payload.status).toBe('ready');
    expect(payload.checks.every((check) => check.status === 'ok')).toBe(true);
    expect(payload.gates).toEqual(guard.snapshot());
    expect(payload.metrics.counters['gate.rejected']).toBe(2);
    expect(payload.timestamp).toBe('2026-10-09T00:00:00.000Z');
    // Ollama 走 /api/tags，其余走 /models
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.anything());
  });

  it('PostgreSQL 探测失败即 degraded，失败项带可定位的原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reachable()),
    );
    const pool = {
      query: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }),
    } as unknown as DbPool;

    const payload = await describeReadiness({
      config: configWith({ chat: 'ollama', embedding: 'ollama' }),
      pool,
      guard: fakeGuard(),
      metrics: createMetrics(),
    });

    expect(payload.status).toBe('degraded');
    const postgres = payload.checks.find((check) => check.name === 'postgres');
    expect(postgres).toMatchObject({ status: 'fail' });
    expect(postgres?.detail).toContain('ECONNREFUSED');
  });

  it('对话模型不可达即 degraded；DeepSeek / OpenAI 兼容服务走 /models', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('deepseek')) throw new Error('探测超时');
      return reachable();
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await describeReadiness({
      config: configWith({ chat: 'deepseek', embedding: 'openai' }),
      pool: healthyPool(),
      guard: fakeGuard(),
      metrics: createMetrics(),
    });

    expect(payload.status).toBe('degraded');
    expect(payload.checks.find((check) => check.name === 'chat-model')).toMatchObject({
      status: 'fail',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/models', expect.anything());
  });
});
