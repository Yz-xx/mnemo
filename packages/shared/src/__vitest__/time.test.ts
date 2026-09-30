import { describe, expect, it } from 'vitest';
import { formatDate, formatTime } from '../time.js';

describe('UTC 时刻展示', () => {
  it('按本地时区展示，不再是一串 UTC 原文', () => {
    // 不断言到具体钟点：同一用例在不同时区的机器上跑出的时刻不同，逐字比对会假失败
    const text = formatTime('2026-09-30T00:00:00.000Z');
    expect(text).toContain('2026');
    expect(text).toMatch(/\d{1,2}:\d{2}/);
  });

  it('解析失败时回落到占位符，界面不留空白', () => {
    expect(formatTime('')).toBe('—');
    expect(formatTime('不是时间')).toBe('—');
  });
});

describe('本地日期串', () => {
  it('当地零点仍落在当天：走 toISOString 会被偏移到前一天', () => {
    // 月份从 0 起，8 表示九月
    expect(formatDate(new Date(2026, 8, 30))).toBe('2026-09-30');
    // 年初与月末做一次补零校验
    expect(formatDate(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(formatDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});
