import type { ChatStreamEvent, ChatStreamFrame } from '@repo/reusable';

/** 轮次中止原因：决定收尾回推的文案，也是「本轮是否被中途掐断」的判据 */
export type RoundAbortReason = 'user' | 'timeout' | 'shutdown' | 'detached-limit';

/**
 * 单个订阅者的待发队列上限：客户端读得再慢，内存也有上界。
 * 超限即判定该订阅者已跟不上，摘除它（轮次本身不受影响，仍在后台跑完）。
 */
const MAX_PENDING_PER_SUBSCRIBER = 4096;

/** 一个订阅者（通常就是一次 HTTP 响应）的待发帧与唤醒钩子 */
interface Subscriber {
  pending: ChatStreamFrame[];
  /** 有新帧或轮次结束时唤醒挂在 await 上的生成器 */
  wake: () => void;
  /** 是否已因积压超限被摘除 */
  overflowed: boolean;
}

/** 轮次运行统计：供收尾日志观测「有多少人读过、脱离多久」 */
export interface RoundStats {
  /** 订阅者数量的历史峰值：大于 1 说明发生过重连 */
  subscriberPeak: number;
  /** 最近一次从「有订阅者」转为「无订阅者」至今的毫秒数；从未脱离过则为 0 */
  detachedMs: number;
}

/**
 * 一轮对话的事件日志：把「一次 HTTP 响应」升格为进程内可独立存活的轮次任务。
 * 订阅者只读事件日志，断开只退订——生成不会因此停下，重连可从任意断点接着读。
 * 接口刻意收得很窄：publish / subscribe / finish / abort 四件事，订阅者队列、超时
 * 定时器与脱离计时都留在实现里。
 */
export interface ChatRound {
  readonly id: string;
  readonly userId: number;
  /** 本轮的中断信号：客户端停止、超时、停机、后台续生成超限任一触发 */
  readonly signal: AbortSignal;
  /** 是否已收尾（正常完成或被中止） */
  readonly ended: boolean;
  /** 被中止时的原因；正常完成时为 null */
  readonly abortReason: RoundAbortReason | null;
  /** 当前订阅者数量：0 表示正在脱离（后台续生成） */
  readonly subscriberCount: number;
  /** 已产出的最大序号：重放窗口的右边界 */
  readonly lastSeq: number;
  /** 发布一个事件：分配序号、写入日志、分发给订阅者 */
  publish(event: ChatStreamEvent): void;
  /** 从 fromSeq 之后开始订阅：先重放日志再接实时帧，直到本轮结束或订阅者断开 */
  subscribe(fromSeq: number, signal: AbortSignal): AsyncGenerator<ChatStreamFrame>;
  /** 正常收尾：唤醒订阅者并通知注册表 */
  finish(): void;
  /** 请求中止：置原因并打中断信号；收尾仍由轮次任务的 finally 调 finish 完成 */
  abort(reason: RoundAbortReason): void;
  /** 运行统计快照 */
  stats(): RoundStats;
}

/** 建轮次所需的参数 */
export interface ChatRoundOptions {
  id: string;
  userId: number;
  /** 单轮最长时长（毫秒）：到点自动中止 */
  maxDurationMs: number;
  /** 事件日志帧数上限：超过即丢最老帧 */
  maxLogFrames: number;
  /** 首个订阅者全部退订时的回调：注册表据此把本轮计入「后台续生成」 */
  onIdle?: () => void;
  /** 收尾时的回调：注册表据此安排日志回收 */
  onEnd?: () => void;
}

/** 建一个轮次：装配事件日志、订阅者集合、中断信号与单轮超时定时器 */
export function createChatRound(options: ChatRoundOptions): ChatRound {
  const { id, userId, maxDurationMs, maxLogFrames, onIdle, onEnd } = options;
  const controller = new AbortController();
  /** 事件日志：按序保留，超出帧数上限即丢最老帧 */
  const log: ChatStreamFrame[] = [];
  const subscribers = new Set<Subscriber>();
  let seq = 0;
  let ended = false;
  let abortReason: RoundAbortReason | null = null;
  let subscriberPeak = 0;
  let detachedSince = 0;

  // 单轮超时上移到轮次侧：定时器 unref，不阻止进程退出。
  // 定时器先于 abortWith 声明无妨——回调在未来才触发，届时 abortWith 已定义。
  const timer = setTimeout(() => abortWith('timeout'), maxDurationMs);
  timer.unref();

  /** 唤醒全部订阅者：新帧到达与轮次结束时都要做，让挂在 await 上的生成器继续 */
  const wakeAll = (): void => {
    for (const subscriber of subscribers) subscriber.wake();
  };

  /** 收尾：置位、清定时器、唤醒订阅者并通知注册表；重复调用只生效一次 */
  const settle = (): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    wakeAll();
    onEnd?.();
  };

  /** 置中止原因并打中断信号：不在此收尾，留给轮次任务的 finally */
  const abortWith = (reason: RoundAbortReason): void => {
    if (abortReason !== null) return;
    abortReason = reason;
    // 中止后轮次任务的 catch 还要 publish 一条 error 帧；若此处直接 settle，
    // publish 会因 ended 被忽略，客户端就收不到「为什么停」的说明
    controller.abort();
  };

  return {
    id,
    userId,
    get signal() {
      return controller.signal;
    },
    get ended() {
      return ended;
    },
    get abortReason() {
      return abortReason;
    },
    get subscriberCount() {
      return subscribers.size;
    },
    get lastSeq() {
      return seq;
    },
    publish(event: ChatStreamEvent): void {
      // 收尾后忽略：中止时最后那条 error 帧已在 finish 之前发出，
      // 之后再来的事件（如模型迟到的 token）不该续写进日志
      if (ended) return;
      seq += 1;
      const frame: ChatStreamFrame = { seq, event };
      log.push(frame);
      if (log.length > maxLogFrames) log.splice(0, log.length - maxLogFrames);
      for (const subscriber of subscribers) {
        subscriber.pending.push(frame);
        if (subscriber.pending.length > MAX_PENDING_PER_SUBSCRIBER) {
          // 跟不上就摘除：留它在集合里只会让内存继续涨
          subscriber.overflowed = true;
          subscribers.delete(subscriber);
          // 摘除前先唤醒，否则它会永远挂在 await 上等不到下次唤醒
          subscriber.wake();
        }
      }
      wakeAll();
    },
    async *subscribe(fromSeq: number, signal: AbortSignal): AsyncGenerator<ChatStreamFrame> {
      // 取快照与挂队必须同步完成：中间若 await，新帧会落在快照之后、挂队之前，
      // 既不在快照里也等不到唤醒，直接丢失
      const subscriber: Subscriber = {
        // 只重放断点之后的帧：之前的已由客户端消费
        pending: log.filter((frame) => frame.seq > fromSeq),
        wake: () => undefined,
        overflowed: false,
      };
      subscribers.add(subscriber);
      subscriberPeak = Math.max(subscriberPeak, subscribers.size);
      // 有订阅者了：脱离计时归零
      detachedSince = 0;
      const onAbort = (): void => subscriber.wake();
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        while (true) {
          // 积压超限或订阅者已断开：立即收尾，剩余实时帧不再补发
          if (subscriber.overflowed || signal.aborted) break;
          const next = subscriber.pending.shift();
          if (next) {
            yield next;
            continue;
          }
          // 队列已空且本轮已收尾：重放完毕，正常结束
          if (ended) break;
          // 队列已空但本轮未完：挂起等待新帧或结束
          await new Promise<void>((resolve) => {
            subscriber.wake = resolve;
          });
          subscriber.wake = () => undefined;
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        subscribers.delete(subscriber);
        // 最后一个订阅者离开且本轮未结束：记脱离起点，通知注册表计入后台续生成
        if (subscribers.size === 0 && !ended) {
          detachedSince = Date.now();
          onIdle?.();
        }
      }
    },
    finish(): void {
      settle();
    },
    abort(reason: RoundAbortReason): void {
      abortWith(reason);
    },
    stats(): RoundStats {
      return {
        subscriberPeak,
        detachedMs: detachedSince > 0 ? Date.now() - detachedSince : 0,
      };
    },
  };
}
