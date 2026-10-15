/**
 * 超时信号：一个受超时与外部信号双重约束的 AbortSignal，并带释放与归因能力。
 */
export interface TimeoutSignal {
  signal: AbortSignal;
  /** 是否由超时触发中断；用于把超时与用户主动取消区分开（两者都是 AbortError） */
  isTimedOut(): boolean;
  /** 释放定时器与监听器；请求结束后必须调用，否则长连接场景会累积泄漏 */
  dispose(): void;
}

/**
 * 构造超时信号。
 *
 * 刻意不用 `AbortSignal.any` / `AbortSignal.timeout`：本仓 engines 只承诺 `node >= 20`，
 * 而前者需要 Node 20.3+、浏览器需要 Chrome 116+，落在边界版本上会直接抛错。
 * 手写组合器的成本很低，却让可用版本下界与仓库声明一致。
 *
 * 归因由本模块负责：外部取消与超时最终都表现为 AbortError，
 * 只有记录「是不是定时器干的」才能在上层给出正确的错误分类。
 */
export function createTimeoutSignal(timeoutMs?: number, external?: AbortSignal): TimeoutSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromExternal = (): void => {
    controller.abort(external?.reason);
  };

  if (external) {
    // 外部信号已中断时不必再挂监听，直接同步中断，避免漏掉这一次
    if (external.aborted) abortFromExternal();
    else external.addEventListener('abort', abortFromExternal, { once: true });
  }

  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', abortFromExternal);
    },
  };
}
