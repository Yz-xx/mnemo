import type { SummaryTask } from './summary.js';
import type { ContextConfig } from '../../../configuration/config/index.js';
import type { StoredMessage } from '../../../entities/conversation.js';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { estimateTextTokens } from './tokens.js';

/** 保留窗口的选择结果 */
export interface RetainedWindow {
  /** 保留的消息：按原顺序，且保证 user / assistant 成对 */
  kept: StoredMessage[];
  /** 被挤出的更早消息：按原顺序，与 kept 互补 */
  dropped: StoredMessage[];
  /** 保留部分的估算 token 数 */
  estimated: number;
}

/** 本轮上下文治理的计划：注入哪些历史、要不要做摘要，以及供日志观测的取舍指标 */
export interface ContextPlan {
  /** 注入模型的未摘要历史（触发后为保留窗口，否则为全部未摘要段） */
  history: StoredMessage[];
  /** 超出保留窗口、需要压缩的段；null 表示本轮无需摘要 */
  summaryTask: SummaryTask | null;
  /**
   * 注入的未摘要历史部分的估算 token 数。
   * 只报「本模块确实选出来的那一段」：摘要份额不算进来，由掌握最终摘要的编排层相加，
   * 计划阶段用的是旧摘要，在这里替它估算只会让上层再反向修正一次。
   */
  historyTokens: number;
  /** 因超窗口被挤出保留窗口的消息条数 */
  trimmedMessages: number;
  /** 本轮生效的注入预算：未触发时为整窗口，触发后为扣除摘要份额后的保留预算 */
  windowBudget: number;
}

/** planContext 的入参：全部历史 + 已持久化的摘要及其截断点 + 治理配置 */
export interface ContextPlanInput {
  /** 全部历史消息：按写入顺序升序，且带 seq */
  history: StoredMessage[];
  /** 已持久化摘要；null 表示尚无摘要 */
  summary: string | null;
  /** 摘要已覆盖到的最后一条 seq；null 表示尚无摘要 */
  summaryUptoSeq: number | null;
  config: ContextConfig;
}

/** 估算一批持久化消息的 token 数：与消息对象口径一致，都按纯文本加权 */
function estimateStored(messages: StoredMessage[]): number {
  return messages.reduce((total, message) => total + estimateTextTokens(message.content), 0);
}

/**
 * 按轮切分消息：每条 user 开启新的一轮，其后的 assistant 归入同一轮。
 * 窗口以「轮」为最小单位，因此裁剪后不会出现只有 assistant、却丢了它对应 user 的半截轮次。
 */
function toRounds(messages: StoredMessage[]): StoredMessage[][] {
  const rounds: StoredMessage[][] = [];
  for (const message of messages) {
    const current = rounds.at(-1);
    if (message.role === 'user' || !current) {
      rounds.push([message]);
    } else {
      current.push(message);
    }
  }
  return rounds;
}

/**
 * 从新到旧整轮选取保留窗口，直到再装下一轮就超出预算为止。
 * 最新一轮无条件保留：它是本轮提问，被裁掉会让模型答非所问，比略微超预算更糟。
 */
export function selectRecentWindow(messages: StoredMessage[], keepBudget: number): RetainedWindow {
  const rounds = toRounds(messages);
  const keptRounds: StoredMessage[][] = [];
  let estimated = 0;

  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const roundTokens = estimateStored(rounds[index]);
    if (keptRounds.length > 0 && estimated + roundTokens > keepBudget) break;
    keptRounds.unshift(rounds[index]);
    estimated += roundTokens;
  }

  const kept = keptRounds.flat();
  return { kept, dropped: messages.slice(0, messages.length - kept.length), estimated };
}

/**
 * 组装本轮上下文治理计划。
 *
 * 只对「未摘要段」（截断点之后）做判断：已摘要部分由摘要代表，不再重复注入。
 * 未超触发阈值时原样全量注入，行为与引入治理前一致；超限则按 keepRatio 收窄到保留窗口，
 * 被挤出的那一段交给摘要（模型调用与落库见 services/conversation/contextGovernance.ts）。
 * 触发判断把摘要份额一并计入——摘要常年驻留上下文，不参与判断会低估占用；
 * 而报告给外部的 historyTokens 只覆盖未摘要历史，摘要由上层与最终摘要一起相加。
 */
export function planContext(input: ContextPlanInput): ContextPlan {
  const { history, summary, summaryUptoSeq, config } = input;
  // 未摘要段：摘要截断点之后的消息；已摘要部分由 summary 代表，不重复注入
  const pending =
    summaryUptoSeq === null ? history : history.filter((message) => message.seq > summaryUptoSeq);
  const summaryTokens = summary ? estimateTextTokens(summary) : 0;
  // 未摘要历史的估算只算一次：触发判断与返回的 historyTokens 都用它
  const pendingTokens = estimateStored(pending);
  const total = summaryTokens + pendingTokens;
  const triggerBudget = config.windowTokens * config.triggerRatio;

  if (total <= triggerBudget) {
    return {
      history: pending,
      summaryTask: null,
      historyTokens: pendingTokens,
      trimmedMessages: 0,
      windowBudget: config.windowTokens,
    };
  }

  // 触发：摘要占用预算，从保留预算里扣掉它，避免「摘要 + 保留窗口」合起来又撑破窗口。
  // 扣到 0 以下时按 0 处理，此时仅靠「最新一轮无条件保留」兜底。
  const keepBudget = Math.max(0, config.windowTokens * config.keepRatio - summaryTokens);
  const { kept, dropped, estimated } = selectRecentWindow(pending, keepBudget);
  const summaryTask: SummaryTask | null =
    dropped.length > 0
      ? { messages: dropped, uptoSeq: dropped[dropped.length - 1].seq, previous: summary }
      : null;

  return {
    history: kept,
    summaryTask,
    historyTokens: estimated,
    trimmedMessages: dropped.length,
    windowBudget: keepBudget,
  };
}

/** 把持久化的历史消息还原为 LangChain 消息对象 */
function toMessages(history: StoredMessage[]): BaseMessage[] {
  return history.map((item) =>
    item.role === 'user' ? new HumanMessage(item.content) : new AIMessage(item.content),
  );
}

/** 组装注入模型的消息：摘要拼成一条 SystemMessage 插在历史之前，与附件预读同构 */
export function assembleContext(summary: string | null, history: StoredMessage[]): BaseMessage[] {
  const messages = toMessages(history);
  if (!summary) return messages;
  return [new SystemMessage(`以下是此前对话的摘要，供你理解上下文：\n${summary}`), ...messages];
}
