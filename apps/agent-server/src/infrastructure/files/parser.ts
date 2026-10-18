import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { getDocument as openPdf } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** 待解析文件：ext 由 magic bytes 判定得出，name 仅用于拼错误文案 */
export interface ParseInput {
  ext: string;
  name: string;
  bytes: Buffer;
}

/**
 * 按扩展名分派解析器，提取可供模型阅读的纯文本。
 * 解析失败一律抛错，不返回空串：静默的空内容会让模型把「读不到」当成「文件是空的」，
 * 进而编造答案，比直接报错更难排查。
 */
export async function extractText(input: ParseInput): Promise<string> {
  switch (input.ext) {
    case 'docx':
      return parseDocx(input);
    case 'xlsx':
      return parseXlsx(input);
    case 'pdf':
      return parsePdf(input);
    default:
      throw new Error(`暂不支持解析《${input.name}》这类文件`);
  }
}

/** 解析 docx：只取纯文本，不保留样式——模型需要的是内容而非排版 */
async function parseDocx({ name, bytes }: ParseInput): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  const text = value.trim();
  if (!text) throw new Error(`《${name}》中没有可读取的文字内容`);
  return text;
}

/** 解析 xlsx：逐工作表转成「单元格以竖线分隔、逐行排列」的文本，模型按行列即可读懂表结构 */
async function parseXlsx({ name, bytes }: ParseInput): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // exceljs 的类型把 Buffer 声明成自造的 `interface Buffer extends ArrayBuffer`，
  // 真实 Buffer 无法满足它；改传按视图长度精确复制的 ArrayBuffer，运行时也正是 JSZip 认的形式
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);

  const sheets: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      // row.values 是 1 起始的稀疏数组，首元素是占位空值，切片后与列号对齐
      const cells = (row.values as unknown[]).slice(1).map(toCellText);
      if (cells.some(Boolean)) rows.push(cells.join(' | '));
    });
    if (rows.length > 0) sheets.push(`【工作表】${sheet.name}\n${rows.join('\n')}`);
  });

  const text = sheets.join('\n\n');
  if (!text) throw new Error(`《${name}》中没有可读取的表格内容`);
  return text;
}

/** 单元格取值可能是富文本、公式或日期，统一转成可读文本；无法识别的结构留空而不拼接噪声 */
function toCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value).trim();

  const cell = value as {
    richText?: { text: string }[];
    result?: unknown;
    text?: string;
  };
  if (Array.isArray(cell.richText))
    return cell.richText
      .map((part) => part.text)
      .join('')
      .trim();
  if (cell.result !== undefined) return toCellText(cell.result);
  return typeof cell.text === 'string' ? cell.text.trim() : '';
}

/** 解析 pdf：逐页抽取文字，按 y 坐标变化断行——同一行的多个文本片段不能粘连成一句 */
async function parsePdf({ name, bytes }: ParseInput): Promise<string> {
  const loadingTask = openPdf({
    data: new Uint8Array(bytes),
    // 后端不渲染画布，关掉字体填充与系统字体，避免无谓依赖；纯文本提取也不需要字体数据
    useSystemFonts: false,
    useWorkerFetch: false,
    disableFontFace: true,
    // 每次解析都会为缺少字体数据打一条警告，压掉以免淹没真正的错误
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let current = '';
      let lastY: number | undefined;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs(y - lastY) > 1) {
          lines.push(current);
          current = '';
        }
        current += item.str;
        lastY = y;
      }
      if (current) lines.push(current);
      const pageText = lines.join('\n').trim();
      if (pageText) pages.push(doc.numPages > 1 ? `【第 ${number} 页】\n${pageText}` : pageText);
    }

    const text = pages.join('\n\n');
    // 扫描件没有文字层，这里读不出内容：明确告知需要文字版，而非让模型自行猜测
    if (!text) throw new Error(`《${name}》中没有可读取的文字，若是扫描件请上传文字版`);
    return text;
  } finally {
    // loadingTask 持有 worker，销毁的是它：同时释放文档与线程资源
    await loadingTask.destroy();
  }
}
