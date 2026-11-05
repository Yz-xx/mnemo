import path from 'node:path';

/** 展示用文件名的保留长度：只存数据库、不参与拼路径，截断是为免超出列宽与界面排版 */
const NAME_MAX_LENGTH = 180;

/**
 * 还原 multer 按 latin1 解码出的文件名，并剥掉客户端可能带上的目录部分。
 * busboy 默认以 latin1 解 filename，UTF-8 中文名到这里会是乱码，需按原字节重解一次；
 * 只取 basename：原始名完全由客户端控制，不能让路径分隔符进入后续展示与下载命名。
 */
export function normalizeFileName(raw: string, maxLength = NAME_MAX_LENGTH): string {
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return path.basename(decoded).slice(0, maxLength);
}
