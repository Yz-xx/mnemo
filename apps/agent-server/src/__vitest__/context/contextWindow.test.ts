import type { StoredMessage } from '../../entities/conversation.js';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { assembleContext, selectRecentWindow } from '../../services/llm/context/index.js';

const CREATED_AT = '2026-10-08T00:00:00.000Z';

/**
 * 造一段持久化历史：rounds 逐轮给出 [提问 token, 回复 token]。
 * 非 ASCII 每字符 1 token，于是 token 数与重复次数相等，断言可直接按字数推算；
 * seq 自 1 连续递增，与 messages 表的自增列语义一致（截断点比较据此进行）。
 */
function storedHistory(rounds: [number, number][]): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const [questionTokens, answerTokens] of rounds) {
    messages.push({
      seq: messages.length + 1,
      id: `u-${messages.length}`,
      role: 'user',
      content: '中'.repeat(questionTokens),
      createdAt: CREATED_AT,
    });
    messages.push({
      seq: messages.length + 1,
      id: `a-${messages.length}`,
      role: 'assistant',
      content: '中'.repeat(answerTokens),
      createdAt: CREATED_AT,
    });
  }
  return messages;
}

describe('selectRecentWindow', () => {
  it('空历史返回空窗口', () => {
    expect(selectRecentWindow([], 10)).toEqual({ kept: [], dropped: [], estimated: 0 });
  });

  it('预算充足时整段保留', () => {
    const result = selectRecentWindow(storedHistory([[10, 10]]), 100);

    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toEqual([]);
    expect(result.estimated).toBe(20);
  });

  it('预算不足时从新到旧保留完整轮次，更早的整轮丢弃', () => {
    // 每轮 20 token，预算 25 只装得下最近一轮
    const result = selectRecentWindow(
      storedHistory([
        [10, 10],
        [10, 10],
        [10, 10],
      ]),
      25,
    );

    expect(result.kept).toHaveLength(2);
    expect(result.kept[0].role).toBe('user');
    expect(result.estimated).toBe(20);
    // 丢弃的是更早两轮，且按原顺序保留
    expect(result.dropped).toHaveLength(4);
    expect(result.dropped[0].role).toBe('user');
  });

  it('裁剪后不会留下没有对应 user 的半截轮次', () => {
    // 第一轮 60 token、第二轮 4 token，预算 10 只够第二轮
    const result = selectRecentWindow(
      storedHistory([
        [30, 30],
        [2, 2],
      ]),
      10,
    );

    expect(result.kept).toHaveLength(2);
    expect(result.kept[0].role).toBe('user');
    // 第一轮的 user 与 assistant 一起被丢掉，不残留孤立的 assistant
    expect(result.dropped).toHaveLength(2);
  });

  it('最新一轮本身就超预算时仍保留它', () => {
    const result = selectRecentWindow(
      storedHistory([
        [10, 10],
        [80, 80],
      ]),
      5,
    );

    expect(result.kept).toHaveLength(2);
    expect(result.estimated).toBe(160);
    expect(result.dropped).toHaveLength(2);
  });
});

describe('assembleContext', () => {
  it('把历史角色还原为 user 与 assistant 两类消息', () => {
    const messages = assembleContext(null, storedHistory([[1, 1]]));

    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[1]).toBeInstanceOf(AIMessage);
  });
});
