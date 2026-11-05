import type { AppDependencies } from '../configuration/dependencies.js';
import http from 'node:http';
import { createApp } from '../app.js';
import { describeChatModel, describeEmbeddingModel } from '../configuration/config/index.js';
import { installShutdownHandlers } from '../infrastructure/lifecycle.js';

export interface StartServerOptions {
  /** 启动时清理掉的会话数，仅用于首条启动日志 */
  prunedSessions: number;
  /** 停止事件循环采样：停机收尾的一环 */
  stopSampling: () => void;
}

/**
 * 起 HTTP 服务：建 app → 设超时 → 监听 → 挂停机钩子。
 * 显式建 server 而非 app.listen：需要设超时与连接回收，拿不到 server 实例就设不了。
 * SSE 的响应期本不受 requestTimeout 约束，其长耗时由「单轮最长时长」兜底（见 docs/adr/0010 决策 6）。
 */
export function startServer(deps: AppDependencies, options: StartServerOptions): void {
  const { config, logger } = deps;
  const app = createApp(deps);

  const server = http.createServer(app);
  server.headersTimeout = config.http.headersTimeoutMs;
  server.requestTimeout = config.http.requestTimeoutMs;
  server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = config.http.maxRequestsPerSocket;

  server.listen(config.port, () => {
    logger.info('智能体服务已启动', {
      url: `http://localhost:${config.port}`,
      chatModel: `${config.llm.provider} / ${describeChatModel(config)}`,
      embeddingModel: `${config.embedding.provider} / ${describeEmbeddingModel(config)}`,
      postgres: `${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`,
      dataDir: config.dataDir,
      uploadDir: config.upload.dir,
      logDir: config.log.dir,
      logLevel: config.log.level,
    });
    if (options.prunedSessions > 0) {
      logger.info('已清理历史登录会话', { count: options.prunedSessions });
    }
  });

  installShutdownHandlers({
    server,
    abortRounds: () => deps.rounds.abortAll('shutdown'),
    flushApiLogs: () => deps.apiLogs.flush(),
    closePool: () => deps.pool.end(),
    closeKnowledge: () => deps.knowledge.close(),
    stopSampling: options.stopSampling,
    graceMs: config.concurrency.shutdownGraceMs,
    logger,
  });
}
