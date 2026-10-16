/**
 * 指标名常量：写入侧（埋点）与读取侧（就绪检查 / 压测脚本）引用同一份定义，
 * 避免各写各的字符串而漂移。独立成文件是为了让 poolMonitor 等下层模块引用常量时
 * 不必反向 import 聚合入口 index.ts（否则形成循环）。
 */
export const METRIC = {
  /** 单次消息落库（含插入消息与更新会话时间）的耗时 */
  DB_APPEND: 'db.appendMs',
  /** 单次知识库检索（含向量化）的耗时 */
  RETRIEVAL: 'retrieval.ms',
  /**
   * 知识库检索累计通过的片段数（已过 minScore 阈值）。
   * 与 RETRIEVAL 的样本数相除即平均召回条数：回答「答非所问是知识库没命中还是模型没用上」
   */
  RETRIEVAL_HITS: 'retrieval.hits',
  /** 单轮模型侧总耗时：从进入本轮流式到大模型流结束 */
  LLM_ROUND: 'llm.roundMs',
  /** 连接池申请从入队到取得连接的等待时长 */
  POOL_WAIT: 'pool.waitMs',
  /** 连接池当前排队深度 */
  POOL_QUEUED: 'pool.queued',
  /** 连接池等待超过建连超时的次数 */
  POOL_WAIT_TIMEOUTS: 'pool.waitTimeouts',
  /** 事件循环延迟：中位 / 长尾 / 峰值 */
  EVENT_LOOP_P50: 'eventLoop.p50Ms',
  EVENT_LOOP_P99: 'eventLoop.p99Ms',
  EVENT_LOOP_MAX: 'eventLoop.maxMs',
} as const;
