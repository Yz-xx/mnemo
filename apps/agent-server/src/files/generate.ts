import fs from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';

/** 支持的导出格式：取值集合同时供工具层的枚举校验使用，避免两处各写一遍 */
export const EXPORT_FORMATS = ['docx', 'xlsx', 'pdf'] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** 生成结果：扩展名与 MIME 随字节一起给出，调用方无需再猜类型 */
export interface GeneratedDocument {
  bytes: Buffer;
  ext: ExportFormat;
  mime: string;
}

const MIME: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** 按格式生成文件字节：内容一律按纯文本处理，不做富文本还原 */
export async function buildDocument(input: {
  format: ExportFormat;
  title: string;
  content: string;
}): Promise<GeneratedDocument> {
  const { format, title, content } = input;
  const bytes =
    format === 'docx'
      ? await buildDocx(title, content)
      : format === 'xlsx'
        ? await buildXlsx(title, content)
        : await buildPdf(title, content);
  return { bytes, ext: format, mime: MIME[format] };
}

/** 标题作为一级标题，正文按行拆段：空行会得到一个空段落，从而保留原文的分段节奏 */
async function buildDocx(title: string, content: string): Promise<Buffer> {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          ...content.split('\n').map((line) => new Paragraph({ text: line })),
        ],
      },
    ],
  });
  return Packer.toBuffer(document);
}

/**
 * 每行映射为表格的一行，行内按制表符或竖线分列。
 * 不猜哪一行是表头：模型产出的表格不一定首行就是标题，加粗反而会误导。
 */
async function buildXlsx(title: string, content: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  // 工作表名有字符与长度限制，先清洗再截断，否则非法名会让生成直接失败
  const sheet = workbook.addWorksheet(sheetName(title));
  for (const line of content.split('\n')) {
    sheet.addRow(splitRow(line));
  }
  // exceljs 自带的 Buffer 声明是自造的假类型，运行时返回的其实是 ArrayBuffer，故显式转换
  return Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
}

/** 把一行文本拆成单元格：优先制表符，其次竖线——模型产出的表格通常用这两种分隔 */
function splitRow(line: string): string[] {
  const separator = line.includes('\t') ? '\t' : line.includes('|') ? '|' : null;
  const cells = (separator ? line.split(separator) : [line]).map((cell) => cell.trim());
  // 竖线表格两端常有空单元格（Markdown 风格写法），去掉两端空列
  while (cells.length > 1 && cells[0] === '') cells.shift();
  while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** 工作表名：去掉 Excel 禁止的字符并截到 31 字符，全空时给一个可读的兜底名 */
function sheetName(title: string): string {
  return (
    title
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || '导出'
  );
}

const PDF_PAGE: [number, number] = [595.28, 841.89]; // A4，单位 pt
const PDF_MARGIN = 56;
const PDF_TITLE_SIZE = 18;
const PDF_BODY_SIZE = 12;
const PDF_LINE_HEIGHT = PDF_BODY_SIZE * 1.8;

/**
 * 可嵌入的中文字体候选：只收单文件 ttf——pdf-lib 依赖的 fontkit 无法把 ttc 字体集
 * 交给 embedFont，而 Linux / macOS 的中文字体基本都是 ttc，故这里只探测 Windows
 * 自带的几款单文件字体。都没有时抛错让调用方换格式，而不是生成一份乱码文件。
 */
const CJK_FONT_CANDIDATES = [
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simkai.ttf',
  'C:/Windows/Fonts/simfang.ttf',
];

/** 字体字节缓存：单文件近 10 MB，探测一次后常驻，避免每次导出都重读磁盘 */
let cjkFontBytes: Buffer | null | undefined;

async function loadCjkFont(): Promise<Buffer | undefined> {
  if (cjkFontBytes !== undefined) return cjkFontBytes ?? undefined;
  for (const candidate of CJK_FONT_CANDIDATES) {
    try {
      cjkFontBytes = await fs.readFile(candidate);
      return cjkFontBytes;
    } catch {
      // 换下一个候选：系统字体路径随 Windows 版本而异，探测失败属预期情况
    }
  }
  cjkFontBytes = null;
  return undefined;
}

async function buildPdf(title: string, content: string): Promise<Buffer> {
  const fontBytes = await loadCjkFont();
  if (!fontBytes) {
    throw new Error('系统里没有可嵌入的中文字体，无法生成 PDF，请改用 docx 或 xlsx 导出');
  }

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // subset 只嵌入实际用到的字形，否则每份 PDF 都要背上近 10 MB 的字体
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const maxWidth = PDF_PAGE[0] - PDF_MARGIN * 2;

  let page = pdf.addPage(PDF_PAGE);
  let cursor = PDF_PAGE[1] - PDF_MARGIN;

  /** 落一行文字：本页写满先换页，避免内容被裁在页边之外 */
  const writeLine = (text: string, size: number): void => {
    if (cursor < PDF_MARGIN + size) {
      page = pdf.addPage(PDF_PAGE);
      cursor = PDF_PAGE[1] - PDF_MARGIN;
    }
    // 空行只占位：drawText 不接受空字符串
    if (text) page.drawText(text, { x: PDF_MARGIN, y: cursor, font, size });
    cursor -= PDF_LINE_HEIGHT;
  };

  for (const line of wrapText(title, font, PDF_TITLE_SIZE, maxWidth)) {
    writeLine(line, PDF_TITLE_SIZE);
  }
  cursor -= PDF_LINE_HEIGHT / 2;
  for (const paragraph of content.split('\n')) {
    for (const line of wrapText(paragraph, font, PDF_BODY_SIZE, maxWidth)) {
      writeLine(line, PDF_BODY_SIZE);
    }
  }

  return Buffer.from(await pdf.save());
}

/** 按可用宽度逐字换行：中文没有词边界，逐字累加宽度是唯一稳妥的折行方式 */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of text) {
    const candidate = current + char;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}
