import type { ChatWindowProps } from './useChatWindow';
import type { ChatMessage } from '../../types';
import type { ComponentPublicInstance, ComputedRef } from 'vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import {
  MESSAGE_GAP,
  buildOffsets,
  computeVisibleRange,
  estimateMessageHeight,
  isFollowing,
  scrollAdjustment,
} from './windowing';

/**
 * 消息列表窗口化（见 docs/adr/0016 阶段 3）：只挂载视口与缓冲区内的消息，
 * 视口外以累计偏移表示，实测高度回填后按需补偿滚动位置。
 *
 * 几何计算全部委托给 `windowing.ts` 的纯函数，本模块只负责与 DOM 打交道：
 * 测量槽位高度、读取滚动几何、把用户的滚动意图（跟随 / 上翻阅读）翻译成写入。
 */

/** 距底部小于该距离时视为“跟随最新内容”，超出则说明用户正在上翻阅读 */
const FOLLOW_THRESHOLD = 80;
/** 视口上下各留 0.75 屏作缓冲：滚到边缘前下一批已挂好，常驻节点又只有一屏半 */
const OVERSCAN_RATIO = 0.75;

/** 需要挂载的一条消息：带上它在虚拟列表中的顶部偏移 */
export interface VirtualMessageSlot {
  index: number;
  message: ChatMessage;
  top: number;
}

export interface VirtualMessagesControls {
  /** 当前需要挂载的消息（视口 + 缓冲区，流式中还会带上末条） */
  items: ComputedRef<VirtualMessageSlot[]>;
  /** 虚拟列表总高度，用来撑起滚动条 */
  totalHeight: ComputedRef<number>;
  /** 滚动容器的滚动回调：按帧更新窗口区间与跟随态 */
  onScroll: () => void;
  /** 模板 `:ref` 的注册入口：把槽位元素交给测量器 */
  registerSlot: (id: string, el: Element | ComponentPublicInstance | null) => void;
  /** 主动回到最新内容：发送消息与切换会话后调用 */
  followToBottom: () => void;
}

export function useVirtualMessages(props: ChatWindowProps): VirtualMessagesControls {
  // 滚动容器的模板 ref 归本组合式函数独占：组件只在模板写 ref="listRef"
  const listRef = useTemplateRef<HTMLElement>('listRef');

  /** 每条消息的高度：未测量的先用估算值撑起占位，进入视口后由实测覆盖 */
  const heights = ref<number[]>([]);
  /** 内容坐标系下的滚动位置（已扣掉列表上内边距，与 offsets 同一原点） */
  const scrollTop = ref(0);
  const viewportHeight = ref(0);
  /** 列表上内边距：offsets 从内容框顶部起算，而 scrollTop 从 padding 外沿起算 */
  const paddingTop = ref(0);
  const following = ref(true);

  const offsets = computed(() => buildOffsets(heights.value, MESSAGE_GAP));
  const totalHeight = computed(() => {
    const list = heights.value;
    if (list.length === 0) return 0;
    const last = list.length - 1;
    return offsets.value[last] + list[last];
  });

  /** 消息 ID → 下标：测量回调按 ID 找回条目，避免 DOM 与数组下标错位 */
  const indexById = computed(() => {
    const map = new Map<string, number>();
    props.messages.forEach((message, index) => map.set(message.id, index));
    return map;
  });

  const items = computed<VirtualMessageSlot[]>(() => {
    const messages = props.messages;
    const listOffsets = offsets.value;
    const range = computeVisibleRange({
      offsets: listOffsets,
      scrollTop: scrollTop.value,
      viewportHeight: viewportHeight.value,
      overscan: viewportHeight.value * OVERSCAN_RATIO,
    });

    const slots: VirtualMessageSlot[] = [];
    for (let index = range.start; index <= range.end; index += 1) {
      const message = messages[index];
      if (message) slots.push({ index, message, top: listOffsets[index] ?? 0 });
    }

    // 流式中的末条必须单独挂着：它的高度每帧都在涨，只有实测才能让占位与滚动条同步。
    // 不能靠扩大区间来包含末条——用户上翻很远时，那会把中间几百条一并挂载
    const lastIndex = messages.length - 1;
    const lastInRange = lastIndex >= range.start && lastIndex <= range.end;
    if (props.streaming && lastIndex >= 0 && !lastInRange) {
      const message = messages[lastIndex];
      if (message) slots.push({ index: lastIndex, message, top: listOffsets[lastIndex] ?? 0 });
    }
    return slots;
  });

  let scrollFrame = 0;
  let slotObserver: ResizeObserver | undefined;
  let listObserver: ResizeObserver | undefined;
  /** 已注册的槽位元素，按消息 ID 索引：同一 ID 换元素时先解除旧观察 */
  const slotElements = new Map<string, Element>();
  /** 元素 → 消息 ID：测量回调只拿到元素，需要反向找回条目 */
  const slotIds = new WeakMap<Element, string>();

  /** 惰性创建观测器：模板 ref 在挂载期间就注册，不能等到 onMounted 才开始观察 */
  function ensureSlotObserver(): ResizeObserver {
    slotObserver ??= new ResizeObserver(handleSlotResize);
    return slotObserver;
  }

  function registerSlot(id: string, el: Element | ComponentPublicInstance | null): void {
    const existing = slotElements.get(id);
    const element = el instanceof Element ? el : null;

    if (!element) {
      if (existing) {
        slotObserver?.unobserve(existing);
        slotElements.delete(id);
      }
      return;
    }
    if (existing === element) return;
    if (existing) slotObserver?.unobserve(existing);
    slotElements.set(id, element);
    slotIds.set(element, id);
    ensureSlotObserver().observe(element);
  }

  /**
   * 实测高度回填：先算出所有变化对滚动位置的影响，再一次性写入高度表并调整 scrollTop。
   * 逐条写入会让偏移表反复失效并触发多次重算；批量写入 + 单次补偿才是可预期的。
   */
  function handleSlotResize(entries: ResizeObserverEntry[]): void {
    const changes: Array<{ index: number; previous: number; measured: number }> = [];

    for (const entry of entries) {
      const id = slotIds.get(entry.target);
      if (!id) continue;
      const index = indexById.value.get(id);
      if (index === undefined) continue;
      const measured = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (measured <= 0) continue;
      const previous = heights.value[index] ?? 0;
      if (Math.abs(measured - previous) < 0.5) continue;
      changes.push({ index, previous, measured });
    }
    if (changes.length === 0) return;

    const list = listRef.value;
    const listOffsets = offsets.value;
    const currentScrollTop = list?.scrollTop ?? 0;

    // 视口上方的条目高度变化会推动下方内容；补偿量必须在写入新高度前按旧偏移算
    let compensation = 0;
    if (list && !following.value) {
      for (const { index, previous, measured } of changes) {
        compensation += scrollAdjustment({
          offsetBefore: listOffsets[index] ?? 0,
          oldHeight: previous,
          newHeight: measured,
          scrollTop: currentScrollTop - paddingTop.value,
        });
      }
    }

    const next = heights.value.slice();
    for (const { index, measured } of changes) next[index] = measured;
    heights.value = next;

    void nextTick(() => {
      const current = listRef.value;
      if (!current) return;
      if (following.value) {
        scrollToBottom();
      } else if (compensation !== 0) {
        current.scrollTop += compensation;
        // 补偿后同步内部坐标，避免窗口区间等到 scroll 事件才跟上而闪一帧
        scrollTop.value = Math.max(0, current.scrollTop - paddingTop.value);
      }
    });
  }

  /** 读取滚动几何：滚动位置换算到内容坐标系，跟随态仍按原始距离判定 */
  function syncScrollState(): void {
    const list = listRef.value;
    if (!list) return;
    scrollTop.value = Math.max(0, list.scrollTop - paddingTop.value);
    following.value = isFollowing({
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
      viewportHeight: list.clientHeight,
      threshold: FOLLOW_THRESHOLD,
    });
  }

  /** 滚到底部并同步内部状态：不等 scroll 事件，否则中间会有一帧窗口还停在原处 */
  function scrollToBottom(): void {
    const list = listRef.value;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    scrollTop.value = Math.max(0, list.scrollTop - paddingTop.value);
    following.value = true;
  }

  function scrollToBottomAfterRender(): void {
    void nextTick(scrollToBottom);
  }

  function followToBottom(): void {
    following.value = true;
    scrollToBottomAfterRender();
  }

  /** 滚动事件按帧合并：一帧内的多次滚动只重算一次区间 */
  function onScroll(): void {
    if (scrollFrame !== 0) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      syncScrollState();
    });
  }

  /** 把高度表对齐到当前消息数：新增补估算值，删除截断 */
  function syncHeights(): void {
    const messages = props.messages;
    if (heights.value.length === messages.length) return;
    const next = heights.value.slice(0, messages.length);
    while (next.length < messages.length) {
      next.push(estimateMessageHeight(messages[next.length]));
    }
    heights.value = next;
  }

  // 数组引用变化 = 整表替换（切换历史会话或新建）：旧高度缓存与阅读位置都失去意义
  watch(
    () => props.messages,
    (messages) => {
      heights.value = messages.map(estimateMessageHeight);
      following.value = true;
      scrollToBottomAfterRender();
    },
    { immediate: true },
  );

  // 条数变化覆盖新增消息与删除空回复；末条的高度增长交给实测回调，避免每帧重复贴底
  watch(
    () => props.messages.length,
    () => {
      syncHeights();
      if (following.value) scrollToBottomAfterRender();
    },
  );

  onMounted(() => {
    const list = listRef.value;
    if (!list) return;
    paddingTop.value = Number.parseFloat(getComputedStyle(list).paddingTop) || 0;
    viewportHeight.value = list.clientHeight;
    scrollTop.value = Math.max(0, list.scrollTop - paddingTop.value);

    listObserver = new ResizeObserver(() => {
      const current = listRef.value;
      if (current) viewportHeight.value = current.clientHeight;
    });
    listObserver.observe(list);
  });

  onBeforeUnmount(() => {
    slotObserver?.disconnect();
    listObserver?.disconnect();
    if (scrollFrame !== 0) cancelAnimationFrame(scrollFrame);
  });

  return { items, totalHeight, onScroll, registerSlot, followToBottom };
}
