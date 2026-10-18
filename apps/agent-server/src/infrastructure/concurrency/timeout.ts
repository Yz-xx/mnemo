/**
 * 给「已发起、但依赖没有取消接口」的调用套上超时上界。
 * 读路径（检索 / 向量化）据此把挂死的调用转成可降级的失败（见 docs/adr/0010 决策 11）。
 */

/** 操作超时：与连接类错误分开表达，调用方据此决定降级还是报错 */
export class OperationTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label}超过 ${timeoutMs}ms 未返回`);
    this.name = 'OperationTimeoutError';
  }
}

/**
 * 在 timeoutMs 内等待任务；超时以 OperationTimeoutError 拒绝。
 * 原任务仍在后台跑（多数依赖不提供取消），因此另挂一个 catch 吞掉它后续的失败，
 * 否则超时收尾之后原任务的 rejection 会变成未处理拒绝，把进程带到退出。
 */
export async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(label, timeoutMs)), timeoutMs);
  });
  task.catch(() => undefined);
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
