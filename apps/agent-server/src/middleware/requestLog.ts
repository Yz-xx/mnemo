import type { ApiLogStore } from '../logging/store.js';
import type { Logger } from '@repo/logger';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HTTP_STATUS } from '@repo/reusable';
import { hasContent, summarize } from '../logging/summarize.js';

/** 请求 ID 取 UUID 前 8 位：足够区分单机并发请求，又便于人工抄读 */
const REQUEST_ID_LENGTH = 8;

/** 不落库的路径：健康检查被客户端按秒轮询，记进来只会把真正要排查的请求挤下去 */
const SKIP_RECORD_PATHS = new Set(['/api/health']);

/** 错误摘要：message 与 stack 都是不可枚举属性，先取成普通对象再脱敏截断 */
function summarizeError(error: Error): string {
  return summarize({ message: error.message, stack: error.stack });
}

/**
 * 请求日志：为每个请求生成短 ID 并挂到 res.locals，供路由层取用；
 * 响应结束时汇总一条结果：入参（查询串、请求体）、出参（响应体）、状态码、耗时与用户，
 * 5xx 附带错误堆栈。SSE 接口不走 res.json，其出参由业务层自行记录。
 *
 * 同一份汇总同时写入 api_logs 表（即管理后台的「API 日志」页），落库是 fire-and-forget：
 * 失败只告警，不影响已经返回给客户端的响应。
 */
export function createRequestLog(logger: Logger, apiLogs: ApiLogStore): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID().slice(0, REQUEST_ID_LENGTH);
    const log = logger.child({ requestId });
    res.locals.requestId = requestId;
    res.locals.log = log;
    // 回写请求 ID：客户端报错时可凭该 ID 直接在日志文件中定位整条链路
    res.setHeader('x-request-id', requestId);

    // 出参：包装 res.json 抓一份响应体，行为与原实现完全一致
    const sendJson = res.json.bind(res);
    res.json = ((payload: unknown) => {
      res.locals.responseBody = summarize(payload);
      return sendJson(payload);
    }) as Response['json'];

    const startedAt = Date.now();
    res.on('finish', () => {
      const status = res.statusCode;
      const error = res.locals.error as Error | undefined;
      const path = req.originalUrl.split('?')[0];
      const durationMs = Date.now() - startedAt;
      const queryParams = hasContent(req.query) ? summarize(req.query) : undefined;
      const requestBody = hasContent(req.body) ? summarize(req.body) : undefined;
      const responseBody = res.locals.responseBody as string | undefined;
      const { userId } = res.locals;

      const fields = {
        method: req.method,
        path,
        queryParams,
        requestBody,
        status,
        durationMs,
        userId,
        responseBody,
        error,
      };
      if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR) log.error('请求处理失败', fields);
      else if (status >= HTTP_STATUS.BAD_REQUEST) log.warn('请求被拒绝', fields);
      else log.info('请求完成', fields);

      if (SKIP_RECORD_PATHS.has(path)) return;
      void apiLogs
        .record({
          requestId,
          method: req.method,
          path,
          status,
          durationMs,
          userId: typeof userId === 'number' ? userId : null,
          queryParams: queryParams ?? null,
          requestBody: requestBody ?? null,
          responseBody: responseBody ?? null,
          error: error ? summarizeError(error) : null,
        })
        .catch((recordError: unknown) => log.warn('接口日志落库失败', { error: recordError }));
    });

    next();
  };
}

/** 读取请求级日志（仅在挂载了 createRequestLog 的应用中调用），自带 requestId */
export function requestLogger(res: Response): Logger {
  return res.locals.log as Logger;
}
