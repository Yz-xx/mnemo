import type { ChatMessage } from '../types';
import { describe, expect, it } from 'vitest';
import {
  buildOffsets,
  computeVisibleRange,
  estimateMessageHeight,
  isFollowing,
  scrollAdjustment,
  totalHeight,
} from '../components/ChatWindow/windowing';

/** 构造一条最小可用的消息，只关心窗口化用到的字段 */
function message(patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm', role: 'assistant', content: '', createdAt: '', ...patch };
}

describe('estimateMessageHeight', () => {
  it('内容越长估算越高', () => {
    const short = estimateMessageHeight(message({ content: '嗯' }));
    const long = estimateMessageHeight(message({ content: '长'.repeat(400) }));
    expect(long).toBeGreaterThan(short);
  });

  it('空内容也给出可点击的最小高度', () => {
    expect(estimateMessageHeight(message())).toBeGreaterThanOrEqual(56);
  });
});

describe('buildOffsets', () => {
  it('相邻两项之间计入间距，首项从 0 开始', () => {
    expect(buildOffsets([100, 200, 50], 34)).toEqual([0, 134, 368]);
  });

  it('空列表没有偏移', () => {
    expect(buildOffsets([], 34)).toEqual([]);
  });
});

describe('totalHeight', () => {
  it('等于末项偏移加末项高度，最后一项之后不再计间距', () => {
    expect(totalHeight([100, 200, 50], 34)).toBe(418);
  });

  it('空列表总高为 0', () => {
    expect(totalHeight([], 34)).toBe(0);
  });
});

describe('computeVisibleRange', () => {
  const offsets = buildOffsets([100, 100, 100, 100, 100], 0);

  it('视口在中间时只覆盖可见项与缓冲外沿', () => {
    // 视口覆盖 150~350，落在第 1 项中部到第 3 项中部
    expect(
      computeVisibleRange({ offsets, scrollTop: 150, viewportHeight: 200, overscan: 0 }),
    ).toEqual({ start: 1, end: 3 });
  });

  it('停在顶部时从第一条开始', () => {
    expect(
      computeVisibleRange({ offsets, scrollTop: 0, viewportHeight: 200, overscan: 0 }).start,
    ).toBe(0);
  });

  it('停在底部时覆盖到最后一条', () => {
    expect(
      computeVisibleRange({ offsets, scrollTop: 300, viewportHeight: 200, overscan: 0 }).end,
    ).toBe(4);
  });

  it('缓冲区把区间向两侧扩张', () => {
    const tight = computeVisibleRange({
      offsets,
      scrollTop: 250,
      viewportHeight: 100,
      overscan: 0,
    });
    const loose = computeVisibleRange({
      offsets,
      scrollTop: 250,
      viewportHeight: 100,
      overscan: 150,
    });
    expect(loose.start).toBeLessThan(tight.start);
    expect(loose.end).toBeGreaterThan(tight.end);
  });

  it('空列表返回空区间', () => {
    expect(
      computeVisibleRange({ offsets: [], scrollTop: 0, viewportHeight: 200, overscan: 0 }),
    ).toEqual({
      start: 0,
      end: -1,
    });
  });
});

describe('isFollowing', () => {
  it('距底部在阈值内视为跟随', () => {
    // 1000 - 850 - 100 = 50，小于阈值 80
    expect(
      isFollowing({ scrollTop: 850, scrollHeight: 1000, viewportHeight: 100, threshold: 80 }),
    ).toBe(true);
  });

  it('上翻超过阈值即退出跟随', () => {
    expect(
      isFollowing({ scrollTop: 800, scrollHeight: 1000, viewportHeight: 100, threshold: 80 }),
    ).toBe(false);
  });
});

describe('scrollAdjustment', () => {
  it('视口上方的条目变高时按增量补偿，下方内容不跳动', () => {
    expect(
      scrollAdjustment({ offsetBefore: 100, oldHeight: 100, newHeight: 160, scrollTop: 300 }),
    ).toBe(60);
  });

  it('条目变矮时补偿为负', () => {
    expect(
      scrollAdjustment({ offsetBefore: 100, oldHeight: 100, newHeight: 40, scrollTop: 300 }),
    ).toBe(-60);
  });

  it('条目仍与视口相交时不补偿', () => {
    expect(
      scrollAdjustment({ offsetBefore: 100, oldHeight: 100, newHeight: 160, scrollTop: 150 }),
    ).toBe(0);
  });

  it('视口下方的条目变化不补偿', () => {
    expect(
      scrollAdjustment({ offsetBefore: 100, oldHeight: 100, newHeight: 160, scrollTop: 0 }),
    ).toBe(0);
  });
});
