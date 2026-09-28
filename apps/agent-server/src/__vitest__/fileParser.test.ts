import { Buffer } from 'node:buffer';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { extractText } from '../files/parser.js';

/** 用 docx 库生成真实 docx 字节：解析器要面对真实文件结构，手工拼的伪字节证明不了什么 */
async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: paragraphs.map((text) => new Paragraph({ children: [new TextRun(text)] })),
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** 用 exceljs 生成真实 xlsx 字节，首行作表头 */
async function buildXlsx(sheetName: string, rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 用 pdf-lib 生成真实 pdf 字节：用内置字体写英文，避免为测试额外嵌入中文字体 */
async function buildPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  let y = page.getHeight() - 60;
  for (const line of lines) {
    page.drawText(line, { x: 60, y, size: 16, font });
    y -= 28;
  }
  return Buffer.from(await doc.save());
}

describe('extractText', () => {
  it('从 docx 中提取正文文本', async () => {
    const bytes = await buildDocx(['季度报告', '营收同比增长 12%']);

    const text = await extractText({ ext: 'docx', name: '季度报告.docx', bytes });

    expect(text).toContain('季度报告');
    expect(text).toContain('营收同比增长 12%');
  });

  it('从 xlsx 中按工作表提取单元格文本', async () => {
    const bytes = await buildXlsx('销售明细', [
      ['姓名', '销售额'],
      ['张三', '12800'],
    ]);

    const text = await extractText({ ext: 'xlsx', name: '销售明细.xlsx', bytes });

    expect(text).toContain('销售明细');
    expect(text).toContain('姓名');
    expect(text).toContain('12800');
  });

  it('从 pdf 中逐页提取文本', async () => {
    const bytes = await buildPdf(['Quarterly Report', 'Revenue +12%']);

    const text = await extractText({ ext: 'pdf', name: 'report.pdf', bytes });

    expect(text).toContain('Quarterly Report');
    expect(text).toContain('Revenue +12%');
  });

  it('不支持的类型抛错，不静默返回空内容', async () => {
    await expect(
      extractText({ ext: 'png', name: '截图.png', bytes: Buffer.from([0x89, 0x50]) }),
    ).rejects.toThrow('暂不支持解析');
  });

  it('内容损坏时抛错，不静默返回空文本', async () => {
    await expect(
      extractText({ ext: 'docx', name: '损坏.docx', bytes: Buffer.from('这不是真正的 docx 内容') }),
    ).rejects.toThrow();
  });
});
