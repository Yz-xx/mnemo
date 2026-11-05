import type { ParseRunner } from '../../../infrastructure/files/parseGovernance.js';
import type { VisionReader } from '../vision.js';
import type { FileSource } from './attachment.js';
import path from 'node:path';
import { tool } from 'langchain';
import { z } from 'zod';
import { formatBytes, toErrorMessage } from '@mnemo/shared';
import { buildDocument, EXPORT_FORMATS } from '../../../infrastructure/files/generate.js';
import { BUDGET_EXHAUSTED_NOTE } from '../context/index.js';
import { readAttachmentText } from './attachment.js';
import { withLabel } from './label.js';
import { readExports, readFileIds, readLogger, readToolBudget, readUserId } from './runtime.js';

/** 导出文件名保留长度：只作展示与下载命名，过长会让列表与下载框都难读 */
const EXPORT_NAME_LIMIT = 60;

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

/** 附件清单：确认本轮有哪些文件、取文件 ID */
function createListFilesTool(files: FileSource) {
  return tool(
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
}

/** 附件读取：图片交给视觉模型，其余按格式抽取，超出单次上限与本轮总额度即截断 */
function createReadFileTool(files: FileSource, vision: VisionReader, parse: ParseRunner) {
  return tool(
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
}

/** 文件导出：把整理好的正文生成 docx / xlsx / pdf 并推给客户端下载 */
function createWriteFileTool(files: FileSource) {
  return tool(
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
}

/**
 * 文件类工具：附件清单、附件读取与文件导出。
 * 三个工具都只认本轮附件（ID 由路由层校验后经 configurable.fileIds 注入），
 * 图片理解能力经 vision 注入：未配视觉模型的环境传 DISABLED_VISION，工具会给出可读提示。
 */
export function createFileTools(files: FileSource, vision: VisionReader, parse: ParseRunner) {
  return [
    withLabel(createListFilesTool(files), '列出文件'),
    withLabel(createReadFileTool(files, vision, parse), '读取文件'),
    withLabel(createWriteFileTool(files), '生成文件'),
  ];
}
