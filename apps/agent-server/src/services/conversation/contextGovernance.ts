import type { ContextConfig } from '../../configuration/config/index.js';
import type { StoredMessage } from '../../entities/conversation.js';
import type { Summarizer } from '../llm/context/index.js';
import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from '@repo/logger';
import {
  assembleContext,
  buildSummaryPrompt,
  estimateTextTokens,
  normalizeSummary,
  planContext,
} from '../llm/context/index.js';

/** 上下文治理的输入：全部历史 + 已持久化摘要 + 依赖（摘要器、落库回调、日志） */
export interface ContextGovernanceInput {
  /** 全部历史消息：按写入顺序升序，且带 seq */
  history: StoredMessage[];
  /** 已持久化摘要；null 表示尚无 */
  summary: string | null;
  /** 摘要已覆盖到的最后一条 seq；null 表示尚无 */
  summaryUptoSeq: number | null;
  config: ContextConfig;
  /** 摘要生成器：复用对话模型单次 invoke，见 services/llm/agent.ts 的 AgentService.summarize */
  summarizer: Summarizer;
  /**
   * 摘要落库：由调用方绑定 userId 与 conversationId，走条件更新保截断点单调，
   * 返回是否真的写入（并发下被更靠前的截断点抢先时返回 false）。
   */
  persistSummary: (summary: string, uptoSeq: number) => Promise<boolean>;
  logger?: Logger;
}

/** 治理结果：直接可用的注入消息 + 供日志观测的取舍指标 */
export interface GovernedContext {
  /** 本轮真正注入模型的消息：摘要（若有）在前，保留窗口在后 */
  messages: BaseMessage[];
  /** 注入部分的估算 token 数 */
  estimatedTokens: number;
  /** 因超窗口被挤出保留窗口的消息条数 */
  trimmedMessages: number;
  /** 本轮生效的注入预算 */
  windowBudget: number;
  /** 本轮是否真的生成并落库了摘要 */
  summarized: boolean;
}

/**
 * 上下文治理的 IO 编排：把纯逻辑的治理计划落到「一次模型调用 + 一次条件写入」。
 *
 * 摘要优先于丢弃：触发时先把被挤出保留窗口的未摘要段交给模型压缩并合进旧摘要；
 * 摘要失败（或产出为空）时不推进截断点、本轮退化为阶段 1 的确定性丢弃，下轮重新尝试——
 * 摘要是锦上添花，任何时候都不阻断对话，也不污染截断点。
 */
export async function governContext(input: ContextGovernanceInput): Promise<GovernedContext> {
  const { history, summary, summaryUptoSeq, config, summarizer, persistSummary, logger } = input;
  const plan = planContext({ history, summary, summaryUptoSeq, config });
  let effectiveSummary = summary;
  let summarized = false;

  const task = plan.summaryTask;
  if (task) {
    try {
      const generated = normalizeSummary(await summarizer.summarize(buildSummaryPrompt(task)));
      if (generated) {
        const persisted = await persistSummary(generated, task.uptoSeq);
        effectiveSummary = generated;
        // 只有真正写进库才算本轮产出摘要：并发下被更靠前的截断点抢先时不计入，
        // 否则埋点会高报落库率（本轮仍用自己生成的摘要，下轮以库中为准）
        summarized = persisted;
        logger?.debug('滚动摘要已更新', {
          uptoSeq: task.uptoSeq,
          compressedMessages: task.messages.length,
          summaryLength: generated.length,
          // 并发下被更靠前的截断点抢先写入时为 false：本轮仍用自己生成的摘要，下轮以库中为准
          persisted,
        });
      } else {
        logger?.warn('摘要产出为空，本轮退化为丢弃最老历史', {
          uptoSeq: task.uptoSeq,
          compressedMessages: task.messages.length,
        });
      }
    } catch (error) {
      // 失败路径带原始 error（格式化层会展开堆栈）；不推进截断点即等于下轮重试
      logger?.warn('摘要生成或落库失败，本轮退化为丢弃最老历史', {
        uptoSeq: task.uptoSeq,
        compressedMessages: task.messages.length,
        error,
      });
    }
  }

  return {
    messages: assembleContext(effectiveSummary, plan.history),
    // 注入总量 = 未摘要历史 + 实际注入的摘要：计划只报前者，摘要份额在这里与最终摘要一次算清——
    // 触发轮生成的新摘要长度可能不同于计划阶段的旧摘要，只有这一层知道最终该用哪个（ADR 0008 决策 6）
    estimatedTokens: plan.historyTokens + estimateTextTokens(effectiveSummary ?? ''),
    trimmedMessages: plan.trimmedMessages,
    windowBudget: plan.windowBudget,
    summarized,
  };
}
