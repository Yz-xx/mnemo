import type { LoadedFile, StoredFile, StreamedUpload } from '../entities/file.js';
import type { FileStore } from '../mappers/file/fileStore.js';

/** 文件读写：客户端侧一律按上传者限定，管理端侧的越界清理另立口径 */

/** 按 ID 集合批量取该用户的文件元数据：用于校验附件归属与列出本轮附件 */
export function listOwnFiles(
  store: Pick<FileStore, 'list'>,
  userId: number,
  ids: string[],
): Promise<StoredFile[]> {
  return store.list(userId, ids);
}

/** 取回该用户的文件元数据与字节；查不到（含不属于该用户）时返回 null */
export function readOwnFile(
  store: Pick<FileStore, 'read'>,
  userId: number,
  id: string,
): Promise<LoadedFile | null> {
  return store.read(userId, id);
}

/** 从临时文件入库：以改名代替复制，字节不再过一遍内存 */
export function saveUploadedFile(
  store: Pick<FileStore, 'saveFromPath'>,
  userId: number,
  upload: StreamedUpload,
): Promise<StoredFile> {
  return store.saveFromPath(userId, upload);
}

/** 删除任意文件（不限上传者）：管理端清理用，元数据与落盘字节一并清理 */
export function removeAnyFile(store: Pick<FileStore, 'removeAny'>, id: string): Promise<boolean> {
  return store.removeAny(id);
}
