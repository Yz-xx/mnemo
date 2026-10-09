import { describe, expect, it } from 'vitest';
import { createToolBudget, estimateTextTokens, truncateToTokens } from '../llm/context/index.js';

/** 造一段非 ASCII 文本：每字符 1 token，于是 token 数与字符数相等，断言可直接按长度推算 */
const wide = (tokens: number): string => '中'.repeat(tokens);

describe('truncateToTokens', () => {
  it('预算非正时返回空串', () => {
    expect(truncateToTokens('中文', 0)).toBe('');
    expect(truncateToTokens('中文', -1)).toBe('');
  });

  it('预算充裕时原样返回', () => {
    expect(truncateToTokens('中文', 100)).toBe('中文');
  });

  it('返回不超过预算的最长前缀', () => {
    expect(truncateToTokens(wide(10), 4)).toBe(wide(4));
  });

  it('ASCII 零头向上取整的口径与估算一致', () => {
    // 10 个 ASCII 字符在 1 token 预算下能留下 4 个：第 5 个就要 2 个 token 了
    expect(truncateToTokens('abcdefghij', 1)).toBe('abcd');
  });

  it('中英混排截断后估算不超过预算', () => {
    const cut = truncateToTokens('ab中文cd中文', 3);

    expect(estimateTextTokens(cut)).toBeLessThanOrEqual(3);
    expect('ab中文cd中文'.startsWith(cut)).toBe(true);
  });
});

describe('createToolBudget', () => {
  it('装得下时原样返回并累计用量', () => {
    const budget = createToolBudget(10);

    expect(budget.admit(wide(4))).toEqual({ text: wide(4), truncated: false });
    expect(budget.usedTokens).toBe(4);
    expect(budget.admit(wide(6))).toEqual({ text: wide(6), truncated: false });
    expect(budget.usedTokens).toBe(10);
  });

  it('装不下时按剩余预算截断并附上说明', () => {
    const budget = createToolBudget(40);
    const admitted = budget.admit(wide(100));

    expect(admitted?.truncated).toBe(true);
    expect(admitted?.text).toContain('上下文预算上限');
    // 截断后连同说明也不越界，模型看到的是完整且可解释的一段
    expect(estimateTextTokens(admitted?.text ?? '')).toBeLessThanOrEqual(40);
    // 记账按实际注入量，不直接置为上限：否则日志里的用量会高报
    expect(budget.usedTokens).toBe(estimateTextTokens(admitted?.text ?? ''));
  });

  it('额度耗尽后返回 null，不再注入任何内容', () => {
    const budget = createToolBudget(40);

    expect(budget.admit(wide(100))).not.toBeNull();
    expect(budget.admit(wide(1))).toBeNull();
  });

  it('预算小到连说明都放不下时返回 null', () => {
    const budget = createToolBudget(1);

    expect(budget.admit(wide(10))).toBeNull();
  });

  it('交付过的文档可登记并查得，供检索去重', () => {
    const budget = createToolBudget(100);

    expect(budget.deliveredDocuments.has('doc-1')).toBe(false);
    budget.deliveredDocuments.add('doc-1');
    expect(budget.deliveredDocuments.has('doc-1')).toBe(true);
  });
});
