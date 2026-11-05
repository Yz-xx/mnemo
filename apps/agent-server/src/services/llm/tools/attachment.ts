import type { ParseRunner } from '../../../infrastructure/files/parseGovernance.js';
import type { FileStore } from '../../../mappers/file/fileStore.js';
import type { VisionReader } from '../vision.js';
import type { Logger } from '@mnemo/logger';
import { extractText } from '../../../infrastructure/files/parser.js';

/** 单次读文件回给模型的正文字数上限：整篇塞进去会挤爆上下文，超出部分截断并说明 */
const CONTENT_LIMIT = 8000;

/** 图片附件：没有可抽取的文字，只能交给视觉模型转述 */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg'];

/** 文件工具需要的存储能力：只取用到的三个方法，调用方无需备齐整个 FileStore */
export type FileSource = Pick<FileStore, 'list' | 'read' | 'save'>;

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
