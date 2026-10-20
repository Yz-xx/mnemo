import type { AppConfig } from '../configuration/config/index.js';
import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { HTTP_STATUS } from '@mnemo/reusable';

/** 上传失败文案：multer 自带的是英文消息，不适合直接透给用户 */
const UPLOAD_FAILED = '文件上传失败，请检查文件大小与格式';

/**
 * 单文件上传中间件。
 * multipart 不经过 express.json，体积与数量上限必须在此单独声明；
 * 字节直接落到临时文件而非整份读入内存：大文件把整个 Buffer 顶在堆上会拖垮事件循环（见 docs/adr/0010 决策 14），
 * 后续类型判定只读回文件头，入库时再把临时文件改名到正式路径。
 * 解析失败（超限等）属客户端问题，补上 400 后交给错误兜底中间件统一回中文文案。
 */
export function createUploadMiddleware(upload: AppConfig['upload']): RequestHandler {
  // 临时文件落在上传根目录下的 .tmp：与按用户分的正式目录分开，正式目录只出现入库完成的文件
  const tempDir = path.join(upload.dir, '.tmp');
  const storage = multer.diskStorage({
    // 目录可能尚不存在（首次上传前无人创建），写入前补建，避免 ENOENT 直接失败
    destination: (_req, _file, callback) => {
      fs.mkdir(tempDir, { recursive: true }, (error) => callback(error, tempDir));
    },
    // 随机名避免并发上传互相覆盖：原始文件名不可信，只进数据库作展示、不参与拼路径
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  });
  const parse = multer({
    storage,
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
