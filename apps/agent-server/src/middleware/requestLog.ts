import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { preview, redactValue } from '@repo/logger';
import type { Logger } from '@repo/logger';
import { HTTP_STATUS } from '@repo/reusable';

/** 请求 ID 取 UUID 前 8 位：足够区分单机并发请求，又便于人工抄读 */
const REQUEST_ID_LENGTH = 8;

/** 入参出参摘要长度上限：只记录开头，避免整包报文把日志文件撑大 */
const PAYLOAD_PREVIEW = 500;

/** 空对象不写日志（express.json 在无请求体时会给出 {}） */
function hasContent(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

/** 先脱敏再截断：顺序不能反，否则截断后只剩字符串，嵌套的密码就遮蔽不到了 */
function summarize(value: unknown): string {
  return preview(redactValue(value), PAYLOAD_PREVIEW);
}

/**
 * 请求日志：为每个请求生成短 ID 并挂到 res.locals，供路由层取用；
 * 响应结束时汇总一条结果：入参（查询串、请求体）、出参（响应体）、状态码、耗时与用户，
 * 5xx 附带错误堆栈。SSE 接口不走 res.json，其出参由业务层自行记录。
 */
export function createRequestLog(logger: Logger): RequestHandler {
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
      const fields = {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        queryParams: hasContent(req.query) ? summarize(req.query) : undefined,
        requestBody: hasContent(req.body) ? summarize(req.body) : undefined,
        status,
        durationMs: Date.now() - startedAt,
        userId: res.locals.userId,
        responseBody: res.locals.responseBody,
        error,
      };
      if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR) log.error('请求处理失败', fields);
      else if (status >= HTTP_STATUS.BAD_REQUEST) log.warn('请求被拒绝', fields);
      else log.info('请求完成', fields);
    });

    next();
  };
}

/** 读取请求级日志（仅在挂载了 createRequestLog 的应用中调用），自带 requestId */
export function requestLogger(res: Response): Logger {
  return res.locals.log as Logger;
}
