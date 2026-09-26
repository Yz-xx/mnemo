import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '@repo/shared';

/** 桌面客户端可能以 file:// 加载页面（Origin 为 null），统一放开跨域 */
export function allowCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  // 跨域下默认读不到自定义响应头，放开后客户端才能拿到请求 ID 用于反馈排查
  res.setHeader('Access-Control-Expose-Headers', 'x-request-id');
  if (req.method === 'OPTIONS') {
    res.sendStatus(HTTP_STATUS.NO_CONTENT);
    return;
  }
  next();
}
