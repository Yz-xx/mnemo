import type { AppConfig } from '../../configuration/config/index.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import type { MetricsRegistry, MetricsSnapshot } from '../../infrastructure/observability/index.js';
import type { ConcurrencyGuard, GateSnapshot } from '../../middleware/concurrencyGuard.js';
import { toErrorMessage } from '@repo/shared';
import {
  describeChatEndpoint,
  describeEmbeddingEndpoint,
} from '../../configuration/config/index.js';
import { withTimeout } from '../../infrastructure/concurrency/timeout.js';

/**
 * 分级健康检查（见 docs/adr/0010 决策 17）：
 * `/api/health` 只回答「进程活着」——轻量、不受闸门影响，过载时运维仍能观测；
 * 本模块支撑的 `/api/health/ready` 才探测外部依赖（PostgreSQL / 模型 / 向量服务），并汇总闸门水位与
 * 指标快照，用一份响应回答「现在能不能正常接活、卡在哪一环」。
 */

/** 单项依赖探测结果：状态、耗时与失败原因，供运维定位是哪一环不健康 */
export interface ReadinessCheck {
  name: string;
  status: 'ok' | 'fail';
  durationMs: number;
  detail?: string;
}

export interface ReadinessPayload {
  status: 'ready' | 'degraded';
  checks: ReadinessCheck[];
  /** 各档闸门水位：过载时一眼看出是哪一档满了、拒了多少 */
  gates: GateSnapshot[];
  /** 指标快照：事件循环延迟、池等待分位数与拒绝计数 */
  metrics: MetricsSnapshot;
  timestamp: string;
}

/** 轻量可达性端点：Ollama 用 `/api/tags`，OpenAI 兼容（含 DeepSeek）用 `/models` */
function reachabilityUrl(baseUrl: string, ollama: boolean): string {
  const root = baseUrl.replace(/\/+$/, '');
  return ollama ? `${root}/api/tags` : `${root}/models`;
}

/**
 * 可达性探测：只看能否连上（任何 HTTP 状态码都算连上）。
 * 就绪探针要回答的是「依赖是否可达」，鉴权失败、404 等仍说明服务在，不该判为不健康。
 */
async function assertReachable(url: string, timeoutMs: number): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  // 只探测连通性，不消费响应体；显式取消避免连接被 body 挂着
  await response.body?.cancel();
}

/** 探测单项依赖：失败只记录下来，不向上抛，保证三项都能得到各自的结论 */
async function probe(
  name: string,
  task: () => Promise<void>,
  timeoutMs: number,
): Promise<ReadinessCheck> {
  const startedAt = Date.now();
  try {
    await withTimeout(task(), timeoutMs, name);
    return { name, status: 'ok', durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      detail: toErrorMessage(error),
    };
  }
}

/** 就绪探测入参：依赖与指标由组合根注入，时间可注入便于测试固定时间戳 */
export interface ReadinessInput {
  config: AppConfig;
  pool: DbPool;
  guard: ConcurrencyGuard;
  metrics: MetricsRegistry;
  now?: Date;
}

/**
 * 组装就绪响应：三项依赖并行探测，任一失败即整体 degraded（仍返回 200 与完整明细，
 * 由调用方决定是否据 status 摘流量）。
 */
export async function describeReadiness(input: ReadinessInput): Promise<ReadinessPayload> {
  const { config, pool, guard, metrics, now = new Date() } = input;
  const timeoutMs = config.observability.readinessProbeTimeoutMs;

  const checks = await Promise.all([
    // PostgreSQL：一条最省的往返即可确认连接可用（连接池自身另由 pool.* 指标观测）
    probe('postgres', async () => void (await pool.query('SELECT 1')), timeoutMs),
    probe(
      'chat-model',
      () =>
        assertReachable(
          reachabilityUrl(describeChatEndpoint(config), config.llm.provider === 'ollama'),
          timeoutMs,
        ),
      timeoutMs,
    ),
    probe(
      'embedding',
      () =>
        assertReachable(
          reachabilityUrl(
            describeEmbeddingEndpoint(config),
            config.embedding.provider === 'ollama',
          ),
          timeoutMs,
        ),
      timeoutMs,
    ),
  ]);

  return {
    status: checks.every((check) => check.status === 'ok') ? 'ready' : 'degraded',
    checks,
    gates: guard.snapshot(),
    metrics: metrics.snapshot(),
    timestamp: now.toISOString(),
  };
}
