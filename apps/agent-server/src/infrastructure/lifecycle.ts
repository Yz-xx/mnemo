import type { Logger } from '@mnemo/logger';
import type http from 'node:http';
import { once } from 'node:events';

/**
 * 停机需要收尾的目标：以能力回调表达（而非直接持有 store 实例），
 * 使基础设施层不必反向依赖业务层的类型。
 */
export interface ShutdownTargets {
  server: http.Server;
  /**
   * 中止全部在途轮次（见 docs/adr/0015 决策 10）：停机时立即掐断生成，
   * 让脱离请求生命周期的后台任务尽快收尾，而不是干等宽限到点。
   */
  abortRounds: (reason: string) => void;
  /** 刷空接口日志缓冲：在途响应收尾后调用，确保停机前日志落尽 */
  flushApiLogs: () => Promise<void>;
  /** 关闭数据库连接池 */
  closePool: () => Promise<void>;
  /** 关闭向量库连接 */
  closeKnowledge: () => Promise<void>;
  /** 停止指标采样 */
  stopSampling: () => void;
  /** 停机宽限（毫秒）：停止接单后等待在途请求收尾的上限 */
  graceMs: number;
  logger: Logger;
}

/**
 * 运行期兜底与优雅停机。
 * - 崩溃：未捕获的异常与拒绝记一条日志后退出，交由进程守护重启，不让进程带着未知状态继续对外服务；
 * - 停机：先停止接单、断开空闲 keep-alive 连接，等在途请求收尾（超过宽限即强制断开），
 *   最后关闭数据库连接池、向量库连接并停止指标采样。停机因此比现在慢，等待上限由 SHUTDOWN_GRACE_MS 约定。
 */
export function installShutdownHandlers(targets: ShutdownTargets): void {
  const {
    server,
    abortRounds,
    flushApiLogs,
    closePool,
    closeKnowledge,
    stopSampling,
    graceMs,
    logger,
  } = targets;
  let stopping = false;

  /** 优雅停机：置位后停止接单、等在途请求收尾，再关池并停采样；重复触发直接返回 */
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('开始优雅停机', { reason, graceMs });
    server.close();
    server.closeIdleConnections();
    // 立即中止全部在途轮次：它们已脱离请求生命周期，不掐断就会一直耗算力到宽限到点
    abortRounds('shutdown');
    // 宽限到点仍未收尾的连接直接断开，避免停机无限期挂住
    const forceTimer = setTimeout(() => {
      logger.warn('停机宽限已到，强制断开剩余连接');
      server.closeAllConnections();
    }, graceMs);
    await once(server, 'close');
    clearTimeout(forceTimer);
    // 在途响应已收尾、finish 回调也已入队：此时刷空缓冲，确保停机前日志落尽
    await flushApiLogs();
    // 再关掉对外连接并停止指标采样
    await closePool();
    await closeKnowledge();
    stopSampling();
    logger.info('已停机', { reason });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝，进程即将退出', { error: reason });
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常，进程即将退出', { error });
    process.exit(1);
  });
}
