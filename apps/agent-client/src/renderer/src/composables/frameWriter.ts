/**
 * 合帧写入器（阶段 1，见 docs/adr/0016）：把逐 token 的增量攒到下一帧一次性交出。
 *
 * 接缝放在这里而不是协议层：`chatStream.ts` 只认「写正文/token」这个动作，
 * 由会话层决定它落到响应式字段上还是先攒一帧。这样协议层不必知道 rAF 的存在，
 * 也能被同步测试；而写入器本身可以在没有 DOM 的环境里用手动调度器测。
 */

/** 帧调度：生产用 requestAnimationFrame，测试用手动执行，二者跨同一接缝 */
export interface FrameScheduler {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

/** 合帧写入器：append 只写缓冲，提交由帧调度驱动 */
export interface FrameWriter {
  /** 追加增量：不触发任何渲染，最多排一次帧 */
  append: (text: string) => void;
  /** 立即交出尚未提交的缓冲（流结束、停止、整段替换前调用） */
  flush: () => void;
}

const browserScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * 创建合帧写入器。
 *
 * 不变量：同一时刻最多只有一个待执行帧；帧回调把缓冲整体交出后清空，
 * 因此 `commit` 收到的是「本次提交的增量」而非全文，调用方自行累加。
 */
export function createFrameWriter(
  commit: (chunk: string) => void,
  scheduler: FrameScheduler = browserScheduler,
): FrameWriter {
  let pending = '';
  let handle: number | null = null;

  function commitPending(): void {
    handle = null;
    if (!pending) return;
    const chunk = pending;
    pending = '';
    commit(chunk);
  }

  function append(text: string): void {
    if (!text) return;
    pending += text;
    if (handle === null) handle = scheduler.request(commitPending);
  }

  function flush(): void {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
    commitPending();
  }

  return { append, flush };
}
