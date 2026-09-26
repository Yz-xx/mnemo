import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '@repo/shared';
import { ERROR_MESSAGE } from '../messages.js';

/**
 * 兜底错误处理：避免异常导致连接悬挂，
 * 并透传请求体解析等客户端错误的原始状态码。
 * 需在全部路由之后注册才能捕获前方中间件抛出的异常。
 * 5xx 只把错误挂到 res.locals，由请求日志统一输出（含堆栈），避免同一次失败产生两条记录。
 */
export function errorHandler(
  error: Error & { status?: number },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = error.status ?? HTTP_STATUS.INTERNAL_SERVER_ERROR;
  if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR) res.locals.error = error;
  if (!res.headersSent) {
    res.status(status).json({
      message: status >= HTTP_STATUS.INTERNAL_SERVER_ERROR ? ERROR_MESSAGE.INTERNAL : error.message,
    });
  }
}
