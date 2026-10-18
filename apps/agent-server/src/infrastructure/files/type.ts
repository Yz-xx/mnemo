import fs from 'node:fs/promises';
import { fileTypeFromBuffer } from 'file-type';

/** file-type 判定所需的文件头字节数：它内部最多读取这么多，读满即可覆盖其探测范围 */
const FILE_HEAD_BYTES = 4100;

/** 由 magic bytes 判定出的文件类型：扩展名用于落盘命名与解析器分派，MIME 用于回传客户端 */
export interface DetectedType {
  ext: string;
  mime: string;
}

/**
 * 按文件头字节判定类型。
 * 不信任扩展名与 MIME：两者都是客户端可任意伪造的提示，
 * 而落盘路径与后续解析器的选择都依赖这里的结论。
 * 无法识别时返回 undefined，由调用方按「不支持的类型」处理，不猜测、不回落。
 */
export async function detectUploadType(bytes: Buffer): Promise<DetectedType | undefined> {
  const detected = await fileTypeFromBuffer(bytes);
  return detected ? { ext: detected.ext, mime: detected.mime } : undefined;
}

/**
 * 按文件路径判定类型：只读回文件头若干字节，不把整个文件读进内存（见 docs/adr/0010 决策 14）。
 * 与 detectUploadType 是同一判定口径，区别只在字节来源——上传链路拿到的是磁盘上的临时文件。
 */
export async function detectUploadTypeFromFile(
  filePath: string,
): Promise<DetectedType | undefined> {
  const handle = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(FILE_HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, FILE_HEAD_BYTES, 0);
    return detectUploadType(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
