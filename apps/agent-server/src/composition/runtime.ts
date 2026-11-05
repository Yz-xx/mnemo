import type { AppConfig } from '../configuration/config/index.js';
import type { MetricsRegistry } from '../infrastructure/observability/index.js';
import type { Logger } from '@mnemo/logger';
import { createConversationLock } from '../infrastructure/concurrency/lock.js';
import { createConcurrencyGuard } from '../middleware/concurrencyGuard.js';
import { createRoundRegistry } from '../services/conversation/roundRegistry.js';

/** 进程内运行时状态：都是内存态，重启即清零 */
export interface Runtime {
  guard: ReturnType<typeof createConcurrencyGuard>;
  chatLock: ReturnType<typeof createConversationLock>;
  rounds: ReturnType<typeof createRoundRegistry>;
}

/**
 * 并发治理与会话运行时：分档闸门、会话级串行锁、在途轮次注册表。
 * 这三者与存储无关，只依赖配置与观测，故与 resources 分开放。
 */
export function createRuntime(
  config: AppConfig,
  logger: Logger,
  metrics: MetricsRegistry,
): Runtime {
  // 并发治理：分档闸门与会话级串行锁都是进程内状态，重启即清零（见 docs/adr/0010）
  const guard = createConcurrencyGuard(config.concurrency, logger);
  const chatLock = createConversationLock(config.concurrency.chat.queueTimeoutMs);
  // 在途轮次注册表（见 docs/adr/0015）：轮次与请求生命周期解耦，客户端断开后生成继续在后台跑完，
  // 重连凭序号从断点续读；注册表另担「后台续生成上限」与「已结束轮次日志 TTL 回收」两件事
  const rounds = createRoundRegistry({
    roundMaxDurationMs: config.concurrency.chatMaxDurationMs,
    roundTtlMs: config.concurrency.sseRoundTtlMs,
    detachedMaxRounds: config.concurrency.sseDetachedMaxRounds,
    maxLogFrames: config.concurrency.sseReplayMaxEvents,
    metrics,
    logger,
  });

  return { guard, chatLock, rounds };
}
