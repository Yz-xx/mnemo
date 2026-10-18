import type { ContextConfig } from '../../configuration/config/index.js';
import type { StoredMessage } from '../../entities/conversation.js';
import type { Summarizer } from '../../services/llm/context/index.js';
import { SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { governContext } from '../../services/conversation/contextGovernance.js';
import {
  assembleContext,
  buildSummaryPrompt,
  normalizeSummary,
  planContext,
  SUMMARY_MAX_TOKENS,
} from '../../services/llm/context/index.js';

/** 窗口预算 100：触发阈值 70，触发后保留预算 40 */
const CONFIG: ContextConfig = {
  windowTokens: 100,
  triggerRatio: 0.7,
  keepRatio: 0.4,
  toolRatio: 0.3,
};

const CREATED_AT = '2026-10-08T00:00:00.000Z';

/**
 * 造一段持久化历史：每轮 user 与 assistant 各 perMessageTokens 个 token。
 * seq 从 1 连续递增，与 messages 表的自增列语义一致（截断点比较据此进行）。
 */
function history(rounds: number, perMessageTokens: number): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (let index = 0; index < rounds; index += 1) {
    const content = '中'.repeat(perMessageTokens);
    messages.push({
      id: `u-${index}`,
      role: 'user',
      content,
      createdAt: CREATED_AT,
      seq: messages.length + 1,
    });
    messages.push({
      id: `a-${index}`,
      role: 'assistant',
      content,
      createdAt: CREATED_AT,
      seq: messages.length + 1,
    });
  }
  return messages;
}

/** 摘要文本：非 ASCII 每字符 1 token，便于按长度推算预算 */
const summaryOf = (tokens: number): string => '摘'.repeat(tokens);

describe('buildSummaryPrompt', () => {
  it('首次摘要只交代需要压缩的对话，不含旧摘要段', () => {
    const prompt = buildSummaryPrompt({
      previous: null,
      messages: history(1, 4),
      uptoSeq: 2,
    });

    expect(prompt).toContain('用户：中中中中');
    expect(prompt).toContain('助手：中中中中');
    expect(prompt).not.toContain('已有摘要');
  });

  it('增量合并时把旧摘要一并交给模型，要求在其基础上续写', () => {
    const prompt = buildSummaryPrompt({
      previous: '用户询问了水果的价格。',
      messages: history(1, 4),
      uptoSeq: 2,
    });

    expect(prompt).toContain('用户询问了水果的价格。');
    expect(prompt).toContain('已有摘要');
  });
});

describe('normalizeSummary', () => {
  it('去掉模型输出首尾的空白', () => {
    expect(normalizeSummary('  摘要正文\n')).toBe('摘要正文');
  });

  it('超出上限时按 token 预算截断，防止误差随轮次累积', () => {
    const normalized = normalizeSummary('中'.repeat(SUMMARY_MAX_TOKENS + 50));

    expect(normalized).toHaveLength(SUMMARY_MAX_TOKENS);
  });
});

describe('planContext', () => {
  it('未超触发阈值时注入全部未摘要历史，且不生成摘要任务', () => {
    // 3 轮 × 20 token = 60，未超过触发阈值 70
    const plan = planContext({
      history: history(3, 10),
      summary: null,
      summaryUptoSeq: null,
      config: CONFIG,
    });

    expect(plan.history).toHaveLength(6);
    expect(plan.summaryTask).toBeNull();
    expect(plan.trimmedMessages).toBe(0);
    expect(plan.windowBudget).toBe(CONFIG.windowTokens);
  });

  it('超阈值时收窄到保留窗口，摘要任务覆盖被挤出的未摘要段及其末条 seq', () => {
    // 5 轮 × 20 token = 100 超过阈值，保留预算 40 装得下最近 2 轮
    const plan = planContext({
      history: history(5, 10),
      summary: null,
      summaryUptoSeq: null,
      config: CONFIG,
    });

    expect(plan.history.map((message) => message.seq)).toEqual([7, 8, 9, 10]);
    expect(plan.summaryTask?.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // 截断点推进到被挤出段的末条：边界紧贴保留窗口起点，无 gap 无重叠
    expect(plan.summaryTask?.uptoSeq).toBe(6);
    expect(plan.summaryTask?.previous).toBeNull();
    expect(plan.trimmedMessages).toBe(6);
    expect(plan.historyTokens).toBe(40);
  });

  it('已有摘要时只对未摘要段做窗口判断，已摘要部分不再重复注入', () => {
    // 截断点 4：前 2 轮已进摘要。触发判断含摘要份额（未摘要段 60 + 摘要 10 = 70，恰达阈值 70 仍不触发），
    // 而返回的 historyTokens 只报未摘要段这一段
    const plan = planContext({
      history: history(5, 10),
      summary: summaryOf(10),
      summaryUptoSeq: 4,
      config: CONFIG,
    });

    expect(plan.history.map((message) => message.seq)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(plan.summaryTask).toBeNull();
    // 计划只报未摘要历史这一段（60）；摘要的 10 由编排层与最终摘要一起相加，不在这里报出
    expect(plan.historyTokens).toBe(60);
  });

  it('摘要占用预算：把总量推过阈值后从保留预算中扣除摘要份额', () => {
    // 摘要 20 + 未摘要段 60 = 80 超阈值；保留预算 40 - 20 = 20 只装得下最近一轮
    const plan = planContext({
      history: history(5, 10),
      summary: summaryOf(20),
      summaryUptoSeq: 4,
      config: CONFIG,
    });

    expect(plan.windowBudget).toBe(20);
    expect(plan.history.map((message) => message.seq)).toEqual([9, 10]);
    expect(plan.summaryTask?.messages.map((message) => message.seq)).toEqual([5, 6, 7, 8]);
    expect(plan.summaryTask?.uptoSeq).toBe(8);
    expect(plan.summaryTask?.previous).toBe(summaryOf(20));
    // 保留窗口只装下最近一轮（20）；摘要的 20 由编排层相加，不在计划的报告里
    expect(plan.historyTokens).toBe(20);
  });

  it('触发但被挤出的段为空时不生成摘要任务', () => {
    // 最新一轮本身就超预算：无条件保留，于是没有可摘要的前缀
    const plan = planContext({
      history: history(1, 40),
      summary: null,
      summaryUptoSeq: null,
      config: CONFIG,
    });

    expect(plan.history).toHaveLength(2);
    expect(plan.summaryTask).toBeNull();
    expect(plan.trimmedMessages).toBe(0);
  });
});

describe('assembleContext', () => {
  it('有摘要时在历史之前插入一条 SystemMessage 并声明它是摘要', () => {
    const messages = assembleContext('用户此前问过水果价格。', history(1, 4));

    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(String(messages[0].content)).toContain('摘要');
    expect(String(messages[0].content)).toContain('用户此前问过水果价格。');
    expect(messages).toHaveLength(3);
  });

  it('没有摘要时只还原历史消息', () => {
    const messages = assembleContext(null, history(1, 4));

    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message instanceof SystemMessage)).toBe(false);
  });
});

/** 摘要落库替身：记录每次写入的摘要与截断点，默认返回"已写入" */
function fakePersist() {
  const writes: { summary: string; uptoSeq: number }[] = [];
  return {
    writes,
    persistSummary: async (summary: string, uptoSeq: number): Promise<boolean> => {
      writes.push({ summary, uptoSeq });
      return true;
    },
  };
}

describe('governContext', () => {
  it('摘要成功时落库新摘要与推进后的截断点，并注入新摘要', async () => {
    const { writes, persistSummary } = fakePersist();
    const summarizer: Summarizer = { summarize: vi.fn(async () => '压缩后的摘要') };

    const governed = await governContext({
      history: history(5, 10),
      summary: null,
      summaryUptoSeq: null,
      config: CONFIG,
      summarizer,
      persistSummary,
    });

    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([{ summary: '压缩后的摘要', uptoSeq: 6 }]);
    expect(governed.summarized).toBe(true);
    expect(String(governed.messages[0].content)).toContain('压缩后的摘要');
    // 摘要在前，保留下来的最近 2 轮在后
    expect(governed.messages).toHaveLength(5);
    expect(governed.trimmedMessages).toBe(6);
  });

  it('摘要调用失败时不落库、不推进截断点，本轮退化为丢弃最老历史', async () => {
    const { writes, persistSummary } = fakePersist();
    const summarizer: Summarizer = {
      summarize: async () => {
        throw new Error('对话模型服务不可用');
      },
    };

    const governed = await governContext({
      history: history(5, 10),
      summary: null,
      summaryUptoSeq: null,
      config: CONFIG,
      summarizer,
      persistSummary,
    });

    // 摘要是锦上添花：失败不阻断对话，也不污染截断点
    expect(writes).toEqual([]);
    expect(governed.summarized).toBe(false);
    expect(governed.messages).toHaveLength(4);
    expect(governed.messages.some((message) => message instanceof SystemMessage)).toBe(false);
  });

  it('摘要结果为空串时按失败处理，不落库也不推进截断点', async () => {
    const { writes, persistSummary } = fakePersist();

    const governed = await governContext({
      history: history(5, 10),
      summary: null,
      summaryUptoSeq: null,
      config: CONFIG,
      summarizer: { summarize: async () => '   ' },
      persistSummary,
    });

    expect(writes).toEqual([]);
    expect(governed.summarized).toBe(false);
  });

  it('摘要失败但已有旧摘要时，仍注入旧摘要并丢掉被挤出的未摘要段', async () => {
    const { writes, persistSummary } = fakePersist();
    const summarizer: Summarizer = {
      summarize: async () => {
        throw new Error('对话模型服务不可用');
      },
    };

    const governed = await governContext({
      history: history(5, 10),
      summary: summaryOf(20),
      summaryUptoSeq: 4,
      config: CONFIG,
      summarizer,
      persistSummary,
    });

    expect(writes).toEqual([]);
    expect(String(governed.messages[0].content)).toContain(summaryOf(20));
    expect(governed.summarized).toBe(false);
  });

  it('未触发阈值时既不调用摘要也不落库', async () => {
    const { writes, persistSummary } = fakePersist();
    const summarize = vi.fn(async () => '不该被调用');

    const governed = await governContext({
      history: history(3, 10),
      summary: null,
      summaryUptoSeq: null,
      config: CONFIG,
      summarizer: { summarize },
      persistSummary,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(governed.messages).toHaveLength(6);
  });

  it('并发下被更靠前的截断点抢先写入时，不计作本轮已落库摘要', async () => {
    // 条件更新落空：库中已有更靠后的截断点，本次写入被挡下
    const governed = await governContext({
      history: history(5, 10),
      summary: null,
      summaryUptoSeq: null,
      config: CONFIG,
      summarizer: { summarize: async () => '压缩后的摘要' },
      persistSummary: async () => false,
    });

    // 埋点按「真的落库」判定，避免高报摘要落库率
    expect(governed.summarized).toBe(false);
    // 落库落空不影响本轮：仍用自己生成的摘要，与自身保留窗口紧贴
    expect(String(governed.messages[0].content)).toContain('压缩后的摘要');
  });

  it('触发轮的报告估算按实际注入的摘要重算，不沿用旧摘要的长度', async () => {
    const { persistSummary } = fakePersist();

    const governed = await governContext({
      history: history(5, 10),
      summary: null,
      summaryUptoSeq: null,
      config: CONFIG,
      summarizer: { summarize: async () => summaryOf(20) },
      persistSummary,
    });

    // 保留窗口 40 + 本轮注入的新摘要 20；旧摘要为 null，照搬计划的估算会漏报那 20
    expect(governed.estimatedTokens).toBe(60);
  });
});
