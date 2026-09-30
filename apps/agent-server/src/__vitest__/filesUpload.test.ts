import type { AppConfig } from '../configuration/config/index.js';
import type { FileStore, UploadedFile } from '../files/store.js';
import type { Request, Response } from 'express';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { HTTP_STATUS } from '@repo/reusable';
import { detectUploadType } from '../files/type.js';
import { handleUploadFile } from '../routes/client/files.js';

/** 最小 PNG 文件头：magic bytes 前 8 字节 + IHDR 块标识，足以判定为图片 */
const PNG_HEADER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
]);

const PDF_BODY = Buffer.from('%PDF-1.7\n1 0 obj\n');

/** 内存版文件存储：替代真实落盘与 MySQL，只实现上传链路会调用的方法 */
class FakeFiles {
  readonly saved: UploadedFile[] = [];

  async save(_userId: number, upload: UploadedFile) {
    this.saved.push(upload);
    return {
      id: 'f-1',
      name: upload.name,
      ext: upload.ext,
      mime: upload.mime,
      size: upload.bytes.length,
      createdAt: '2026-09-27T00:00:00.000Z',
    };
  }
}

/** 路由层的假响应：只记录状态码与响应体 */
class FakeHttpResponse {
  readonly locals = { userId: 7 };
  statusCode: number = HTTP_STATUS.OK;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.body = payload;
    return this;
  }
}

/** 只声明上传接口用到的配置，其余留空——路由层不读别的配置 */
function fakeDeps(
  files: FakeFiles,
  allowedTypes: string[],
): Parameters<typeof handleUploadFile>[0] {
  return {
    files: files as unknown as FileStore,
    config: { upload: { allowedTypes } } as unknown as AppConfig,
  };
}

/** 假请求：req.file 由 multer 中间件注入，未带文件时为 undefined */
function fakeRequest(file?: Partial<Express.Multer.File>): Request {
  return { file } as unknown as Request;
}

/** 按 multer 的 latin1 解码规则构造文件名，用于验证中文名还原 */
function latin1Name(name: string): string {
  return Buffer.from(name, 'utf8').toString('latin1');
}

describe('detectUploadType', () => {
  it('按 magic bytes 识别 PDF', async () => {
    await expect(detectUploadType(PDF_BODY)).resolves.toEqual({
      ext: 'pdf',
      mime: 'application/pdf',
    });
  });

  it('识别 PNG 图片', async () => {
    await expect(detectUploadType(PNG_HEADER)).resolves.toEqual({
      ext: 'png',
      mime: 'image/png',
    });
  });

  it('无法识别的字节返回 undefined，不按扩展名或 MIME 猜测', async () => {
    await expect(
      detectUploadType(Buffer.from('这只是一个纯文本文件，没有可辨认的文件头')),
    ).resolves.toBeUndefined();
  });
});

describe('handleUploadFile', () => {
  it('未携带文件时返回 400', async () => {
    const files = new FakeFiles();
    const res = new FakeHttpResponse();

    await handleUploadFile(fakeDeps(files, ['pdf']), fakeRequest(), res as unknown as Response);

    expect(res.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body).toEqual({ message: '请选择要上传的文件' });
    expect(files.saved).toEqual([]);
  });

  it('类型不在白名单内时返回 400 且不落库', async () => {
    const files = new FakeFiles();
    const res = new FakeHttpResponse();

    await handleUploadFile(
      fakeDeps(files, ['pdf']),
      fakeRequest({ buffer: PNG_HEADER, originalname: 'shot.png', size: PNG_HEADER.length }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body).toEqual({ message: '不支持该文件类型' });
    expect(files.saved).toEqual([]);
  });

  it('合法文件按 magic bytes 判定类型后落库并返回 201', async () => {
    const files = new FakeFiles();
    const res = new FakeHttpResponse();

    await handleUploadFile(
      fakeDeps(files, ['pdf']),
      // 扩展名伪装成图片，仍应按内容判定为 PDF 并放行
      fakeRequest({ buffer: PDF_BODY, originalname: 'fake.png', size: PDF_BODY.length }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(HTTP_STATUS.CREATED);
    expect(files.saved).toHaveLength(1);
    expect(files.saved[0].ext).toBe('pdf');
    expect(files.saved[0].bytes).toEqual(PDF_BODY);
    expect(res.body).toMatchObject({ id: 'f-1', ext: 'pdf', size: PDF_BODY.length });
  });

  it('中文文件名按 UTF-8 还原后保存', async () => {
    const files = new FakeFiles();
    const res = new FakeHttpResponse();

    await handleUploadFile(
      fakeDeps(files, ['pdf']),
      fakeRequest({
        buffer: PDF_BODY,
        originalname: latin1Name('季度报告.pdf'),
        size: PDF_BODY.length,
      }),
      res as unknown as Response,
    );

    expect(files.saved[0].name).toBe('季度报告.pdf');
  });
});
