import path from 'node:path';
import { normalizeFileName } from '../../infrastructure/files/name.js';
import { detectUploadTypeFromFile } from '../../infrastructure/files/type.js';

/** 有 magic bytes 的二进制文档：扩展名必须与内容一致 */
const BINARY_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx']);
/** 无 magic bytes 的纯文本：只认扩展名，按 UTF-8 直读 */
const TEXT_EXTENSIONS = new Set(['txt', 'md']);

/** 文本类扩展名判定：解析任务据此决定直读还是走 extractText */
export function isTextExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext);
}

/** 上传临时文件的必要信息：不依赖 multer 类型，便于单测直接构造 */
export interface UploadedFileLike {
  path: string;
  originalname: string;
  size: number;
}

/** 通过校验的文件信息：ext 用于解析器分派，mime 回传客户端 */
export interface KnowledgeFileMeta {
  ext: string;
  mime: string;
  fileName: string;
  fileSize: number;
}

/**
 * 知识库文件入参校验：按 magic bytes + 扩展名双校验。
 * - 二进制文档：内容必须可识别，且与扩展名一致（防伪造扩展名）；
 * - TXT/MD：本身没有文件头特征，只接受 .txt / .md 扩展名；
 * - 其余一律拒绝，不做「猜一个解析器试试」的回落。
 */
export async function inspectKnowledgeFile(
  file: UploadedFileLike,
): Promise<{ ok: true; value: KnowledgeFileMeta } | { ok: false; message: string }> {
  const fileName = normalizeFileName(file.originalname);
  const rawExt = path.extname(fileName).slice(1).toLowerCase();
  const detected = await detectUploadTypeFromFile(file.path);

  if (detected) {
    // 无扩展名的二进制文档同样拒绝：类型必须由「内容 + 扩展名」共同确认，不能只看文件头
    if (!rawExt) {
      return { ok: false, message: '文件缺少扩展名，无法确认文件类型' };
    }
    if (rawExt !== detected.ext) {
      return { ok: false, message: '文件扩展名与内容不一致，请确认文件未被改后缀' };
    }
    if (!BINARY_EXTENSIONS.has(detected.ext)) {
      return { ok: false, message: '仅支持 PDF / Word / Excel / TXT / Markdown 文件' };
    }
    return {
      ok: true,
      value: { ext: detected.ext, mime: detected.mime, fileName, fileSize: file.size },
    };
  }

  if (!isTextExtension(rawExt)) {
    return { ok: false, message: '仅支持 PDF / Word / Excel / TXT / Markdown 文件' };
  }
  return {
    ok: true,
    value: {
      ext: rawExt,
      mime: rawExt === 'md' ? 'text/markdown' : 'text/plain',
      fileName,
      fileSize: file.size,
    },
  };
}
