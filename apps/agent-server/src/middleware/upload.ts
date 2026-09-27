import multer from 'multer';
import type { RequestHandler } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import type { AppConfig } from '../config.js';

/** 上传失败文案：multer 自带的是英文消息，不适合直接透给用户 */
const UPLOAD_FAILED = '文件上传失败，请检查文件大小与格式';

/**
 * 单文件上传中间件。
 * multipart 不经过 express.json，体积与数量上限必须在此单独声明；
 * 先整份读入内存，是因为类型判定与落盘命名都要靠原始字节读 magic bytes。
 * 解析失败（超限等）属客户端问题，补上 400 后交给错误兜底中间件统一回中文文案。
 */
export function createUploadMiddleware(upload: AppConfig['upload']): RequestHandler {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: upload.maxBytes, files: upload.maxFiles },
  }).single('file');

  return (req, res, next) => {
    parse(req, res, (error: unknown) => {
      if (!error) {
        next();
        return;
      }
      // 原始 multer 错误挂到 cause：文案要中文化，但排查超限/格式问题时不能丢掉底层原因
      const failure = new Error(UPLOAD_FAILED, { cause: error }) as Error & { status?: number };
      failure.status = HTTP_STATUS.BAD_REQUEST;
      next(failure);
    });
  };
}
