import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectKnowledgeFile } from '../../services/knowledge/index.js';
import { TEST_ROOT } from '../helpers/fakeEmbeddings.js';

/** 最小 PDF 文件头：足以被 file-type 判定为 pdf */
const PDF_BODY = Buffer.from('%PDF-1.7\n1 0 obj\n');

/** 最小 PNG 文件头：判定为 png，用于验证白名单外类型被拒 */
const PNG_HEADER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
]);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(TEST_ROOT, 'inspect-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** multer / busboy 以 latin1 解码 filename：单测按真实链路的入参形状构造 */
function multerFileName(name: string): string {
  return Buffer.from(name, 'utf8').toString('latin1');
}

/** 把字节写到临时文件，返回 multer 落盘形状的出参 */
function uploadedFile(name: string, content: Buffer) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  return { path: filePath, originalname: multerFileName(name), size: content.length };
}

describe('inspectKnowledgeFile', () => {
  it('TXT 无文件头特征时按扩展名放行，MIME 为 text/plain', async () => {
    const result = await inspectKnowledgeFile(
      uploadedFile('说明.txt', Buffer.from('纯文本内容，没有可识别的文件头')),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ ext: 'txt', mime: 'text/plain', fileName: '说明.txt' });
    }
  });

  it('Markdown 按扩展名放行，MIME 为 text/markdown', async () => {
    const result = await inspectKnowledgeFile(uploadedFile('说明.md', Buffer.from('# 标题')));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mime).toBe('text/markdown');
  });

  it('PDF 内容与扩展名一致时放行', async () => {
    const result = await inspectKnowledgeFile(uploadedFile('report.pdf', PDF_BODY));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ ext: 'pdf', mime: 'application/pdf' });
  });

  it('扩展名与内容不一致时拒绝，不按扩展名猜解析器', async () => {
    const result = await inspectKnowledgeFile(uploadedFile('report.txt', PDF_BODY));

    expect(result).toEqual({ ok: false, message: '文件扩展名与内容不一致，请确认文件未被改后缀' });
  });

  it('白名单外的类型（PNG）拒绝', async () => {
    const result = await inspectKnowledgeFile(uploadedFile('shot.png', PNG_HEADER));

    expect(result).toEqual({
      ok: false,
      message: '仅支持 PDF / Word / Excel / TXT / Markdown 文件',
    });
  });

  it('无扩展名的二进制文档拒绝：类型必须由内容与扩展名共同确认', async () => {
    const result = await inspectKnowledgeFile(uploadedFile('report', PDF_BODY));

    expect(result).toEqual({ ok: false, message: '文件缺少扩展名，无法确认文件类型' });
  });

  it('无文件头且扩展名不在白名单时拒绝', async () => {
    const result = await inspectKnowledgeFile(
      uploadedFile('script.exe', Buffer.from('任意二进制内容')),
    );

    expect(result.ok).toBe(false);
  });
});
