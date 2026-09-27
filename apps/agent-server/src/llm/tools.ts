import path from 'node:path';
import { tool } from 'langchain';
import type { ToolRunnableConfig } from '@langchain/core/tools';
import { toErrorMessage } from '@repo/shared';
import { z } from 'zod';
import type { Logger } from '@repo/logger';
import { buildDocument, EXPORT_FORMATS } from '../files/generate.js';
import { extractText } from '../files/parser.js';
import type { FileStore } from '../files/store.js';
import type { KnowledgeStore } from '../rag/store.js';
import { DISABLED_VISION } from './vision.js';
import type { VisionReader } from './vision.js';

/** 检索词为用户原文，截断后写入日志，避免日志行过长 */
const QUERY_PREVIEW = 80;

/** 单次读文件回给模型的正文字数上限：整篇塞进去会挤爆上下文，超出部分截断并说明 */
const CONTENT_LIMIT = 8000;

/** 导出文件名保留长度：只作展示与下载命名，过长会让列表与下载框都难读 */
const EXPORT_NAME_LIMIT = 60;

/** 图片附件：没有可抽取的文字，只能交给视觉模型转述 */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg'];

/** 文件工具需要的存储能力：只取用到的三个方法，调用方无需备齐整个 FileStore */
export type FileSource = Pick<FileStore, 'list' | 'read' | 'save'>;

/** 一次导出产出的文件引用：Agent 在流结束后推给客户端，供用户点击下载 */
export interface GeneratedFileRef {
  fileId: string;
  name: string;
  size: number;
}

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

/** 从运行时配置中取出本轮导出文件的收集器：由 Agent 注入，工具只往里追加 */
function readExports(config?: ToolRunnableConfig): GeneratedFileRef[] | undefined {
  const exported = config?.configurable?.exported;
  return Array.isArray(exported) ? (exported as GeneratedFileRef[]) : undefined;
}

/**
 * 从运行时配置中取出本轮检索来源的收集器：由 Agent 注入，检索工具只往里追加文档名。
 * 来源由此确定地流向客户端，而不是靠模型在正文里自行标注。
 */
function readSources(config?: ToolRunnableConfig): string[] | undefined {
  const sources = config?.configurable?.sources;
  return Array.isArray(sources) ? (sources as string[]) : undefined;
}

/** 从运行时配置中取出当前用户 ID：调用者身份由 Agent 经 configurable 注入 */
function readUserId(config?: ToolRunnableConfig): number {
  const userId = config?.configurable?.userId;
  if (!Number.isInteger(userId)) {
    throw new Error('缺少当前用户身份，无法检索知识库');
  }
  return userId as number;
}

/**
 * 从运行时配置中取出本轮附件 ID。
 * 名单在路由层校验后可注入，工具只按这份名单办事：模型即使编出别的 ID 也读不到东西。
 */
function readFileIds(config?: ToolRunnableConfig): string[] {
  const ids = config?.configurable?.fileIds;
  return Array.isArray(ids) ? (ids as string[]) : [];
}

/** 取请求级日志：由 Agent 经 configurable 下传，未注入时静默跳过，工具不强依赖日志 */
function readLogger(config?: ToolRunnableConfig): Logger | undefined {
  const logger = config?.configurable?.logger as Logger | undefined;
  return typeof logger?.debug === 'function' ? logger : undefined;
}

/** 白名单校验后计算算术表达式，避免执行任意代码 */
function evaluateExpression(expression: string): number {
  if (!/^[\d+\-*/().\s]+$/.test(expression)) {
    throw new Error('表达式包含非法字符');
  }
  const result: unknown = new Function(`return (${expression});`)();
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error('计算结果无效');
  }
  return result;
}

/** 文件大小转成可读文本，让模型对文件体量有概念 */
function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
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
 */
export async function readAttachmentText(
  files: FileSource,
  vision: VisionReader,
  userId: number,
  fileId: string,
  logger?: Logger,
): Promise<string | null> {
  const loaded = await files.read(userId, fileId);
  if (!loaded) return null;

  const isImage = IMAGE_EXTS.includes(loaded.file.ext);
  const text = isImage
    ? await vision.describe({ bytes: loaded.bytes, mime: loaded.file.mime })
    : await extractText({ ext: loaded.file.ext, name: loaded.file.name, bytes: loaded.bytes });

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
 * 组装 Agent 工具集：知识库检索、附件清单与读取、文件导出、当前时间、算术计算。
 * 图片理解能力经 vision 注入：未配视觉模型的环境传 DISABLED_VISION，工具会给出可读提示。
 */
export function createTools(
  knowledge: KnowledgeStore,
  files: FileSource,
  vision: VisionReader = DISABLED_VISION,
) {
  const searchKnowledgeBase = tool(
    async ({ query }, config) => {
      const results = await knowledge.search(query, { userId: readUserId(config) });
      // 检索质量直接决定回答质量：命中数与最高分是排查「答非所问 / 未命中」的关键指标
      readLogger(config)?.debug('检索知识库', {
        query: query.slice(0, QUERY_PREVIEW),
        hits: results.length,
        topScore: results[0] ? Number(results[0].score.toFixed(3)) : undefined,
        // 出参摘要：命中来源文档，用于判断"是没检索到"还是"检索到了但答偏了"
        sources: results.length > 0 ? results.map((item) => item.title).join('、') : undefined,
      });
      if (results.length === 0) return '知识库中没有检索到相关内容。';
      // 命中的文档名一并交给 Agent 推给客户端，来源标签因此由服务端确定地给出，
      // 不指望模型在正文里照抄出处（提示词已要求，但小模型遵循率撑不起主链路）
      readSources(config)?.push(...results.map((item) => item.title));
      return results
        .map((item, index) => `【片段${index + 1}】来源《${item.title}》\n${item.content}`)
        .join('\n\n');
    },
    {
      name: 'search_knowledge_base',
      description: '在本地知识库中检索资料。问题涉及已上传的文档、内部资料或专有知识时使用。',
      schema: z.object({
        query: z.string().describe('检索用的关键词或问题'),
      }),
    },
  );

  const listFiles = tool(
    async (_input, config) => {
      const ids = readFileIds(config);
      if (ids.length === 0) return '本轮对话没有附带文件。';
      const stored = await files.list(readUserId(config), ids);
      if (stored.length === 0) return '本轮对话没有附带文件。';
      return stored
        .map((file) => `${file.id}｜${file.name}｜${file.ext}｜${formatSize(file.size)}`)
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
          readUserId(config),
          fileId,
          readLogger(config),
        );
        // 读不到要让模型知道原因并如实转达，抛错只会把整轮对话打断
        return text ?? '该文件不存在或已失效，请让用户重新上传。';
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

  const getCurrentTime = tool(
    async () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    {
      name: 'get_current_time',
      description: '获取当前日期与时间。问题涉及“今天”“现在”等时间概念时使用。',
      schema: z.object({}),
    },
  );

  const calculator = tool(
    async ({ expression }) => {
      try {
        return String(evaluateExpression(expression));
      } catch {
        return '表达式无法计算，请检查后重试。';
      }
    },
    {
      name: 'calculator',
      description: '计算只包含数字与 + - * / ( ) 的算术表达式。',
      schema: z.object({
        expression: z.string().describe('算术表达式，例如 (12+8)*3/5'),
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
        return `已生成文件《${stored.name}》（${formatSize(stored.size)}），用户可直接下载。`;
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

  return [searchKnowledgeBase, listFiles, readFile, writeFile, getCurrentTime, calculator];
}
