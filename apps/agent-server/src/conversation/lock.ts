/**
 * 同会话互斥：同一 conversationId 同刻只允许一轮在途。
 *
 * 并发两轮会让消息交错、滚动摘要在同一截断点上竞争，用户看到「答案答的是上一问」；
 * 只按会话维度互斥，不动全局锁。等待超过上限即抛 ConversationBusyError，
 * 由路由按「可重试的过载」返回 503。取舍见 docs/adr/0010 决策 12。
 */

/** 会话被上一轮久占、等待超时：路由据此返回 503 */
export class ConversationBusyError extends Error {
  constructor(conversationId: string) {
    super(`会话 ${conversationId} 仍在处理上一轮请求`);
    this.name = 'ConversationBusyError';
  }
}

/** 会话级串行锁：接口只有一件事——把一轮任务排到该会话的队尾 */
export interface ConversationLock {
  /** 串行执行同一会话的一轮任务；等待超时抛 ConversationBusyError */
  run<T>(conversationId: string, task: () => Promise<T>): Promise<T>;
}

/** 建一个会话级串行锁：等待上限在建锁时给定，与闸门排队上限同源 */
export function createConversationLock(timeoutMs: number): ConversationLock {
  /** 每个会话一条等待链：链尾指向「该会话最后一轮」的完成 Promise */
  const chains = new Map<string, Promise<void>>();

  const run = async <T>(conversationId: string, task: () => Promise<T>): Promise<T> => {
    // 先把自己挂到队尾（供后来的请求等待），再去等前一轮收尾
    const previous = chains.get(conversationId) ?? Promise.resolve();
    let done: () => void = () => undefined;
    const self = new Promise<void>((resolve) => {
      done = resolve;
    });
    // 无论前一轮成功还是失败，链都要继续往下走，否则一次异常会卡死整个会话
    const tail = previous.then(
      () => self,
      () => self,
    );
    chains.set(conversationId, tail);

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        previous.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
      if (timedOut) throw new ConversationBusyError(conversationId);
      return await task();
    } finally {
      if (timer) clearTimeout(timer);
      done();
      // 链尾已回到自己说明后面没人排队，清掉以免 Map 随会话数无限增长
      if (chains.get(conversationId) === tail) chains.delete(conversationId);
    }
  };

  return { run };
}
