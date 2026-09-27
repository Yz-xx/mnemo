import { Buffer } from 'node:buffer';
import express from 'express';
import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../config.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createUploadMiddleware } from '../middleware/upload.js';

const PDF_BODY = Buffer.from('%PDF-1.7\n1 0 obj\n');

/** 上传配置：体积上限由用例控制，默认放宽到 1 MB */
function uploadConfig(maxBytes = 1024 * 1024): AppConfig['upload'] {
  return { dir: 'unused', maxBytes, maxFiles: 1, allowedTypes: ['pdf'] };
}

/**
 * 起一个只挂上传中间件与错误兜底的临时服务，用真实 multipart 请求验证解析行为。
 * 中间件本身不做文件名还原（那是路由的职责），因此这里看到的是 multer 的原始输出。
 */
async function withServer(
  upload: AppConfig['upload'],
  run: (baseUrl: string) => Promise<Response>,
): Promise<Response> {
  const app = express();
  app.post('/upload', createUploadMiddleware(upload), (req, res) => {
    res.json({ name: req.file?.originalname, size: req.file?.size });
  });
  app.use(errorHandler);

  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}/upload`);
  } finally {
    server.close();
  }
}

/** 手工拼 multipart 报文：filename 按 UTF-8 字节直接写入，与浏览器发请求的方式一致 */
function multipartBody(fileName: string, content: Buffer): { body: Buffer; boundary: string } {
  const boundary = '----vitestboundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n',
      'utf8',
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  return { body, boundary };
}

function post(baseUrl: string, fileName: string, content: Buffer): Promise<Response> {
  const { body, boundary } = multipartBody(fileName, content);
  return fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

describe('createUploadMiddleware', () => {
  it('解析出的中文文件名是 latin1 形态，需按原字节还原', async () => {
    const res = await withServer(uploadConfig(), (baseUrl) =>
      post(baseUrl, '季度报告.pdf', PDF_BODY),
    );

    const payload = (await res.json()) as { name: string; size: number };
    expect(payload.size).toBe(PDF_BODY.length);
    // 浏览器把 filename 按 UTF-8 字节直接写入报文，busboy 默认按 latin1 解读，
    // 因此这里必然是「乱码」形态；路由层据此还原成 UTF-8。
    // 本用例锁定该前提：multer 或 busboy 的默认行为一旦改变，这里会先失败，提醒同步调整还原逻辑
    expect(Buffer.from(payload.name, 'latin1').toString('utf8')).toBe('季度报告.pdf');
  });

  it('超出体积上限时按 400 返回，而不是落到 500', async () => {
    const res = await withServer(uploadConfig(8), (baseUrl) =>
      post(baseUrl, 'big.pdf', Buffer.alloc(64, 0x20)),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ message: '文件上传失败，请检查文件大小与格式' });
  });
});
