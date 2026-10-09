import type { AppConfig } from '../configuration/config/index.js';
import type { FileStore, StreamedUpload } from '../files/store/index.js';
import type { Request, Response } from 'express';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HTTP_STATUS } from '@repo/reusable';
import { detectUploadType, detectUploadTypeFromFile } from '../files/type.js';
import { handleUploadFile } from '../routes/client/files.js';
import { TEST_ROOT } from './fakeEmbeddings.js';

/** 最小 PNG 文件头：magic bytes 前 8 字节 + IHDR 块标识，足以判定为图片 */
const PNG_HEADER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
]);

const PDF_BODY = Buffer.from('%PDF-1.7\n1 0 obj\n');

/** 临时文件目录：模拟 multer 落盘位置；用例结束后整目录删除，连带清掉未被搬走的临时文件 */
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(TEST_ROOT, 'upload-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 把字节写成临时文件，返回路径——等价于 multer 落盘后 req.file.path 指向的文件 */
function writeTempFile(name: string, content: Buffer): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** 内存版文件存储：替代真实落盘与 MySQL，只实现上传链路会调用的方法 */
class FakeFiles {
  readonly saved: (StreamedUpload & { bytes: Buffer })[] = [];

  async saveFromPath(_userId: number, upload: StreamedUpload) {
    // 读回字节后删除，模拟 rename 把临时文件搬到正式路径
    const bytes = fs.readFileSync(upload.tempPath);
    fs.rmSync(upload.tempPath, { force: true });
    this.saved.push({ ...upload, bytes });
    return {
      id: 'f-1',
      name: upload.name,
      ext: upload.ext,
      mime: upload.mime,
      size: upload.size,
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
    // 并发闸门挂在上传路由外层，本组用例只测处理函数本身，给个空替身
    guard: {
      middleware: () => (_req: Request, _res: Response, next: () => void) => next(),
      snapshot: () => [],
    },
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

describe('detectUploadTypeFromFile', () => {
  it('读文件头判定类型，与缓冲区判定同口径', async () => {
    const filePath = writeTempFile('report.pdf', PDF_BODY);
    await expect(detectUploadTypeFromFile(filePath)).resolves.toEqual({
      ext: 'pdf',
      mime: 'application/pdf',
    });
  });

  it('无法识别的文件头返回 undefined，不按扩展名猜测', async () => {
    const filePath = writeTempFile(
      'note.bin',
      Buffer.from('这只是一个纯文本文件，没有可辨认的文件头'),
    );
    await expect(detectUploadTypeFromFile(filePath)).resolves.toBeUndefined();
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

  it('类型不在白名单内时返回 400、不落库且清掉临时文件', async () => {
    const files = new FakeFiles();
    const res = new FakeHttpResponse();
    const filePath = writeTempFile('shot.png', PNG_HEADER);

    await handleUploadFile(
      fakeDeps(files, ['pdf']),
      fakeRequest({ path: filePath, originalname: 'shot.png', size: PNG_HEADER.length }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body).toEqual({ message: '不支持该文件类型' });
    expect(files.saved).toEqual([]);
    // 类型不符时临时文件同样要清掉，避免临时目录堆积脏文件
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('合法文件读文件头判定类型后落库并返回 201', async () => {
    const files = new FakeFiles();
    const res = new FakeHttpResponse();
    const filePath = writeTempFile('fake.png', PDF_BODY);

    await handleUploadFile(
      fakeDeps(files, ['pdf']),
      // 扩展名伪装成图片，仍应按内容判定为 PDF 并放行
      fakeRequest({ path: filePath, originalname: 'fake.png', size: PDF_BODY.length }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(HTTP_STATUS.CREATED);
    expect(files.saved).toHaveLength(1);
    expect(files.saved[0].ext).toBe('pdf');
    expect(files.saved[0].bytes).toEqual(PDF_BODY);
    expect(res.body).toMatchObject({ id: 'f-1', ext: 'pdf', size: PDF_BODY.length });
    // 入库成功的临时文件已被 rename 搬走，原路径不再存在
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('中文文件名按 UTF-8 还原后保存', async () => {
    const files = new FakeFiles();
    const res = new FakeHttpResponse();
    const filePath = writeTempFile('report.pdf', PDF_BODY);

    await handleUploadFile(
      fakeDeps(files, ['pdf']),
      fakeRequest({
        path: filePath,
        originalname: latin1Name('季度报告.pdf'),
        size: PDF_BODY.length,
      }),
      res as unknown as Response,
    );

    expect(files.saved[0].name).toBe('季度报告.pdf');
  });
});
