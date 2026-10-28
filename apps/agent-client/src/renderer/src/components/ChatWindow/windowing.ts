import type { ChatMessage } from '../../types';

/**
 * 消息列表的窗口化几何计算（见 docs/adr/0016 阶段 3）。
 *
 * 本模块只做纯计算：高度估算、累计偏移、可见区间、滚动跟随判定与锚定补偿。
 * 所有 DOM 测量都留在 `useVirtualMessages` 里，这里不碰浏览器 API，因而全部可单测——
 * 「滚动会不会跳」这种最容易出错的部分，因此不依赖真实窗口也能验证。
 */

/** 消息之间的垂直间距，与 ChatWindow.less 中 `.chat__slot` 的间距保持一致 */
export const MESSAGE_GAP = 34;

/** 按正文宽度折算的每行字符数：只求量级正确，误差由实测回填纠正 */
const CHARS_PER_LINE = 40;
/** 单行高度（16px 字号 × 1.75 行高 ≈ 28px） */
const LINE_HEIGHT_PX = 28;
/** 用户短句与空消息的最小高度，保证占位块可被指针命中 */
const MIN_HEIGHT_PX = 56;
/** 助手消息额外的操作行与段间距 */
const ASSISTANT_PADDING_PX = 36;

/**
 * 估算一条消息的高度：只用于「尚未挂载过」的条目撑起占位。
 * 一旦该条进入视口被实测，调用方会用真实高度覆盖，估算不参与最终布局。
 */
export function estimateMessageHeight(message: ChatMessage): number {
  const length = message.content.trim().length;
  const lines = Math.max(1, Math.ceil(length / CHARS_PER_LINE));
  return Math.max(MIN_HEIGHT_PX, lines * LINE_HEIGHT_PX + ASSISTANT_PADDING_PX);
}

/**
 * 把每条高度累加成顶部偏移。末尾条目之后不再计间距，
 * 否则列表底部会多出一段空隙，滚动到底时会露出不存在的留白。
 */
export function buildOffsets(heights: readonly number[], gap: number): number[] {
  const offsets = new Array<number>(heights.length);
  let cursor = 0;
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index] = cursor;
    cursor += heights[index] + gap;
  }
  return offsets;
}

/** 所有条目排开后的总高度：末项偏移加末项高度，空列表为 0 */
export function totalHeight(heights: readonly number[], gap: number): number {
  if (heights.length === 0) return 0;
  const last = heights.length - 1;
  return buildOffsets(heights, gap)[last] + heights[last];
}

/** 窗口化区间：闭区间，`end` 小于 `start` 表示没有需要挂载的条目 */
export interface VisibleRange {
  start: number;
  end: number;
}

/** 可见区间计算的入参：偏移表已由调用方缓存，避免每次滚动重算前缀和 */
export interface VisibleRangeParams {
  offsets: readonly number[];
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
}

/**
 * 计算需要挂载的区间：视口加上下缓冲区。
 *
 * 起点取「最后一个顶部不高于视口上沿的条目」，因为高度未知时，
 * 该项仍可能有一部分落在视口里；终点取「最后一个顶部不高于视口下沿的条目」。
 * 两种情况都比严格可见范围多要一条，多挂一条的代价远小于漏挂导致的空白。
 */
export function computeVisibleRange({
  offsets,
  scrollTop,
  viewportHeight,
  overscan,
}: VisibleRangeParams): VisibleRange {
  if (offsets.length === 0) return { start: 0, end: -1 };

  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + viewportHeight + overscan;

  let start = lowerBound(offsets, top) - 1;
  if (start < 0) start = 0;

  let end = lowerBound(offsets, bottom + 1) - 1;
  if (end < start) end = start;
  if (end > offsets.length - 1) end = offsets.length - 1;

  return { start, end };
}

/** 跟随态判定的入参 */
export interface FollowParams {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  /** 距底小于该值即视为仍在跟随最新输出 */
  threshold: number;
}

/** 用户是否停在列表底部阈值内；用于决定新内容到来时是贴底还是保持阅读位置 */
export function isFollowing({
  scrollTop,
  scrollHeight,
  viewportHeight,
  threshold,
}: FollowParams): boolean {
  return scrollHeight - scrollTop - viewportHeight <= threshold;
}

/** 高度回填后是否需要补偿 `scrollTop` 的入参 */
export interface ScrollAdjustmentParams {
  /** 该条之前的累计高度（含间距） */
  offsetBefore: number;
  oldHeight: number;
  newHeight: number;
  scrollTop: number;
}

/**
 * 某条实测高度变化后，为保持用户正在阅读的内容不动，应给 `scrollTop` 加多少。
 *
 * 只有整条都落在视口上方时，它的伸缩才会推动下方内容位移，需要等量补偿；
 * 与视口相交或位于视口下方时，变化发生在用户眼前或身后，补偿反而制造跳动。
 */
export function scrollAdjustment({
  offsetBefore,
  oldHeight,
  newHeight,
  scrollTop,
}: ScrollAdjustmentParams): number {
  if (offsetBefore + oldHeight > scrollTop) return 0;
  return newHeight - oldHeight;
}

/** 二分查找第一个不小于目标值的位置，用于把像素坐标映射到条目下标 */
function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
