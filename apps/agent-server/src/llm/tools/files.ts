import type { ParseRunner } from '../../files/parseGovernance.js';
import type { FileStore } from '../../files/store/index.js';
import type { VisionReader } from '../vision.js';
import type { Logger } from '@repo/logger';
import path from 'node:path';
import { tool } from 'langchain';
import { z } from 'zod';
import { formatBytes, toErrorMessage } from '@repo/shared';
import { buildDocument, EXPORT_FORMATS } from '../../files/generate.js';
import { extractText } from '../../files/parser.js';
import { BUDGET_EXHAUSTED_NOTE } from '../context/index.js';
import { withLabel } from './label.js';
import { readExports, readFileIds, readLogger, readToolBudget, readUserId } from './runtime.js';

/** 单次读文件回给模型的正文字数上限：整篇塞进去会挤爆上下文，超出部分截断并说明 */
const CONTENT_LIMIT = 8000;

/** 导出文件名保留长度：只作展示与下载命名，过长会让列表与下载框都难读 */
const EXPORT_NAME_LIMIT = 60;

/** 图片附件：没有可抽取的文字，只能交给视觉模型转述 */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg'];

/** 文件工具需要的存储能力：只取用到的三个方法，调用方无需备齐整个 FileStore */
export type FileSource = Pick<FileStore, 'list' | 'read' | 'save'>;

/** 剥掉模型可能带上的目录与扩展名并截断：文件名要能安全地进数据库与下载框 */
function normalizeExportName(raw: string): string {
  // 统一按 POSIX 分隔符处理：模型可能给出 Windows 风格路径，而这里只关心最后一段
  const normalized = raw.replace(/\\/g, '/');
  const base = path.posix
    .basename(normalized)
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .trim();
  return base.slice(0, EXPORT_NAME_LIMIT) || '导出文件';
}

/** 超长正文截断后附上说明，模型据此知道后面还有内容，而不是以为文件就到此为止 */
function clampContent(text: string): string {
  return text.length <= CONTENT_LIMIT
    ? text
    : `${text.slice(0, CONTENT_LIMIT)}\n\n（正文过长，以上为前 ${CONTENT_LIMIT} 字）`;
}

/**
 * 把附件读成给模型看的文本：图片交给视觉模型转述，其余按格式抽取正文，超长统一截断。
 * 工具与「本轮附件预读」共用同一实现——两处若各自判断文件类型，新增格式时必然走偏。
 * 元数据存在但字节取不到时返回 null，由调用方决定提示方式；其余异常原样抛出。
 * 文本解析走独立闸门（parse）：CPU 密集，过载时抛错，由调用方降级为「读取失败」（决策 14）。
 */
export async function readAttachmentText(
  files: FileSource,
  vision: VisionReader,
  parse: ParseRunner,
  userId: number,
  fileId: string,
  logger?: Logger,
): Promise<string | null> {
  const loaded = await files.read(userId, fileId);
  if (!loaded) return null;

  const isImage = IMAGE_EXTS.includes(loaded.file.ext);
  const text = isImage
    ? await vision.describe({ bytes: loaded.bytes, mime: loaded.file.mime })
    : await parse.run(() =>
        extractText({ ext: loaded.file.ext, name: loaded.file.name, bytes: loaded.bytes }),
      );

  // 读取量与是否截断是排查「模型说文件是空的」这类问题的关键现场
  logger?.debug(isImage ? '理解图片' : '读取附件', {
    fileId,
    name: loaded.file.name,
    ext: loaded.file.ext,
    chars: text.length,
  });
  return clampContent(text);
}

/**
 * 文件类工具：附件清单、附件读取与文件导出。
 * 三个工具都只认本轮附件（ID 由路由层校验后经 configurable.fileIds 注入），
 * 图片理解能力经 vision 注入：未配视觉模型的环境传 DISABLED_VISION，工具会给出可读提示。
 */
export function createFileTools(files: FileSource, vision: VisionReader, parse: ParseRunner) {
  const listFiles = tool(
    async (_input, config) => {
      const ids = readFileIds(config);
      if (ids.length === 0) return '本轮对话没有附带文件。';
      const stored = await files.list(readUserId(config), ids);
      if (stored.length === 0) return '本轮对话没有附带文件。';
      return stored
        .map((file) => `${file.id}｜${file.name}｜${file.ext}｜${formatBytes(file.size)}`)
        .join('\n');
    },
    {
      name: 'list_files',
      description:
        '列出本轮对话中用户附带的文件及其文件 ID。需要确认有哪些文件，或需要文件 ID 时使用。',
      schema: z.object({}),
    },
  );

  const readFile = tool(
    async ({ fileId }, config) => {
      if (!readFileIds(config).includes(fileId)) {
        return '该文件不在本轮对话的附件中，请让用户重新上传后再读取。';
      }
      try {
        const text = await readAttachmentText(
          files,
          vision,
          parse,
          readUserId(config),
          fileId,
          readLogger(config),
        );
        // 读不到要让模型知道原因并如实转达，抛错只会把整轮对话打断
        if (text === null) return '该文件不存在或已失效，请让用户重新上传。';
        // 单次读的上限之外还有本轮总额度：同轮反复读文件会累计计入，超出即截断
        const budget = readToolBudget(config);
        const admitted = budget ? budget.admit(text) : { text, truncated: false };
        return admitted?.text ?? BUDGET_EXHAUSTED_NOTE;
      } catch (error) {
        return toErrorMessage(error);
      }
    },
    {
      name: 'read_file',
      description:
        '读取本轮对话中附件文件的内容，图片附件（png / jpg / jpeg）也用它读取，图片会由视觉模型转述成文字。附件内容通常已随对话预先给出，仅在需要复核原文或内容缺失时调用；不要凭文件名猜测内容，也不要声称自己看不到图片。',
      schema: z.object({
        fileId: z.string().describe('附件文件 ID，取自本轮附件清单或 list_files 的返回结果'),
      }),
    },
  );

  const writeFile = tool(
    async ({ name, format, content }, config) => {
      try {
        const title = normalizeExportName(name);
        const built = await buildDocument({ format, title, content });
        const stored = await files.save(readUserId(config), {
          // 展示名带扩展名：用户下载后一眼能看出文件类型
          name: `${title}.${built.ext}`,
          ext: built.ext,
          mime: built.mime,
          bytes: built.bytes,
        });
        // 交给 Agent 在流末尾推给客户端：工具返回值只进模型上下文，客户端看不到
        readExports(config)?.push({
          fileId: stored.id,
          name: stored.name,
          size: stored.size,
        });
        readLogger(config)?.debug('生成导出文件', {
          format,
          name: stored.name,
          size: stored.size,
        });
        return `已生成文件《${stored.name}》（${formatBytes(stored.size)}），用户可直接下载。`;
      } catch (error) {
        // 生成失败要让模型知道原因并如实转达，抛错只会把整轮对话打断
        return toErrorMessage(error);
      }
    },
    {
      name: 'write_file',
      description:
        '把整理好的内容导出为 docx、xlsx 或 pdf 文件供用户下载。需要把结果整理成文件、转换格式或另存一份时使用；content 必须是完整正文，不要写“同上”或省略内容。',
      schema: z.object({
        name: z.string().describe('文件名（不含扩展名），例如「会议纪要」'),
        format: z.enum(EXPORT_FORMATS).describe('导出格式'),
        content: z.string().describe('要写入文件的完整正文，换行用 \\n 表示'),
      }),
    },
  );

  return [
    withLabel(listFiles, '列出文件'),
    withLabel(readFile, '读取文件'),
    withLabel(writeFile, '生成文件'),
  ];
}
