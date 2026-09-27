import { fileTypeFromBuffer } from 'file-type';

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
