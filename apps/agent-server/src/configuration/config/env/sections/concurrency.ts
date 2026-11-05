import type { ConcurrencyConfig, LlmProvider } from '../types.js';
import process from 'node:process';
import { readGate, toCount, toNumber } from '../parsers.js';

/**
 * 并发治理：默认值只保证不雪崩，吞吐基线须按容量模型压测后校准（见 docs/adr/0010）。
 * 入口三档（对话 / 上传 / 普通读写）与内部四道闸门（模型 / 摘要 / 检索 / 附件解析）配额互不挤占。
 */
export function loadConcurrencyConfig(provider: LlmProvider): ConcurrencyConfig {
  return {
    // 对话流：真实瓶颈在模型算力，档位收得最紧
    chat: readGate('CHAT', {
      maxInFlight: 8,
      softLimit: 6,
      queueLimit: 32,
      queueTimeoutMs: 20000,
    }),
    // 上传解析：CPU 密集且会阻塞事件循环，档位最紧
    upload: readGate('UPLOAD', {
      maxInFlight: 2,
      softLimit: 1,
      queueLimit: 8,
      queueTimeoutMs: 10000,
    }),
    // 知识库解析：长任务且吃 embedding 服务，与上传请求分开计量；默认值沿用上传档
    ingest: readGate('INGEST', {
      maxInFlight: 2,
      softLimit: 1,
      queueLimit: 8,
      queueTimeoutMs: 10000,
    }),
    // 普通读写：查询轻、往返多，给较宽上限
    crud: readGate('CRUD', {
      maxInFlight: 32,
      softLimit: 24,
      queueLimit: 64,
      queueTimeoutMs: 5000,
    }),
    chatMaxDurationMs: toNumber(process.env.CHAT_MAX_DURATION_MS, 180000),
    sseDrainTimeoutMs: toNumber(process.env.SSE_DRAIN_TIMEOUT_MS, 30000),
    shutdownGraceMs: toNumber(process.env.SHUTDOWN_GRACE_MS, 15000),
    // 模型闸门按 provider 分档：本地 Ollama 算力紧只放 1~2，线上 DeepSeek 可放宽（决策 9）
    model: readGate(
      'MODEL',
      provider === 'deepseek'
        ? { maxInFlight: 8, softLimit: 6, queueLimit: 32, queueTimeoutMs: 20000 }
        : { maxInFlight: 2, softLimit: 1, queueLimit: 8, queueTimeoutMs: 20000 },
    ),
    // 摘要闸门并发 1 且不排队：满即拒绝，由治理层退化为丢弃最老历史，不拖慢首 token（决策 10）
    summary: readGate('SUMMARY', {
      maxInFlight: 1,
      softLimit: 1,
      queueLimit: 0,
      queueTimeoutMs: 3000,
    }),
    // 检索闸门独立小并发：检索缺失只影响本轮答案质量，不阻断对话（决策 11）
    retrieval: readGate('RETRIEVAL', {
      maxInFlight: 4,
      softLimit: 2,
      queueLimit: 8,
      queueTimeoutMs: 3000,
    }),
    // 附件解析闸门：解析是主线程 CPU 密集计算，并发收到最小，排队只为削峰（决策 14）
    parse: readGate('PARSE', {
      maxInFlight: 2,
      softLimit: 1,
      queueLimit: 8,
      queueTimeoutMs: 5000,
    }),
    retrievalTimeoutMs: toNumber(process.env.RETRIEVAL_TIMEOUT_MS, 8000),
    // 熔断默认值：连续 5 次失败即快速失败 30 秒，之后放一个探测（决策 16）
    circuitFailureThreshold: toNumber(process.env.CIRCUIT_FAILURE_THRESHOLD, 5),
    circuitCooldownMs: toNumber(process.env.CIRCUIT_COOLDOWN_MS, 30000),
    // 断点续传：已结束轮次的日志保留一分钟，够弱网客户端重连；过后即回收
    sseRoundTtlMs: toNumber(process.env.SSE_ROUND_TTL_MS, 60000),
    // 后台续生成上限：无订阅者的轮次最多 16 个，防止断开后算力无声堆积
    sseDetachedMaxRounds: toCount(process.env.SSE_DETACHED_MAX_ROUNDS, 16),
    // 重放窗口：单轮最多保留 2000 帧，超出丢最老帧（早期帧丢失不影响最终正文）
    sseReplayMaxEvents: toCount(process.env.SSE_REPLAY_MAX_EVENTS, 2000),
  };
}
