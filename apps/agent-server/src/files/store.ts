import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** 待入库的上传内容：类型已由 magic bytes 判定，name 仅作展示 */
export interface UploadedFile {
  name: string;
  ext: string;
  mime: string;
  bytes: Buffer;
}

/** 已入库的文件元数据：客户端与工具层都只看这份信息 */
export interface StoredFile {
  id: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  createdAt: string;
}

/** 取出的原始字节所在位置：路径由元数据推导，因此两者必须成对返回，不能只给其一 */
export interface LoadedFile {
  file: StoredFile;
  bytes: Buffer;
}

interface FileRow extends RowDataPacket {
  id: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  created_at: Date;
}

/** 行转领域对象：日期与数值在这里统一归一，避免各调用方各自转换 */
function toStoredFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    name: row.name,
    ext: row.ext,
    mime: row.mime,
    size: Number(row.size),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 上传文件存储：磁盘放原始字节，MySQL 放元数据。
 * 落盘路径为 `<根目录>/<userId>/<fileId>.<ext>`，两个约定合一：
 * 按用户分目录便于隔离与清理；文件名只用 ID + 判定出的扩展名——
 * 原始文件名完全由客户端控制，可能带路径分隔符或超长字符，因此只进数据库作展示，不参与拼路径。
 */
export class FileStore {
  constructor(
    private readonly pool: Pool,
    private readonly baseDir: string,
  ) {}

  /** 该用户的上传目录：所有落盘路径都从这里派生，路径规则只此一处 */
  private userDir(userId: number): string {
    return path.join(this.baseDir, String(userId));
  }

  /** 落盘并写入元数据；元数据写失败时回删文件，避免留下无人引用的孤儿文件 */
  async save(userId: number, upload: UploadedFile): Promise<StoredFile> {
    const record: StoredFile = {
      id: randomUUID(),
      name: upload.name,
      ext: upload.ext,
      mime: upload.mime,
      size: upload.bytes.length,
      createdAt: new Date().toISOString(),
    };
    const dir = this.userDir(userId);
    const target = path.join(dir, `${record.id}.${record.ext}`);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(target, upload.bytes);
    try {
      await this.pool.execute(
        `INSERT INTO files (id, user_id, name, ext, mime, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          userId,
          record.name,
          record.ext,
          record.mime,
          record.size,
          new Date(record.createdAt),
        ],
      );
    } catch (error) {
      await fs.rm(target, { force: true });
      throw error;
    }
    return record;
  }

  /**
   * 取回该用户的文件元数据与原始字节。
   * 查不到记录（含不属于当前用户）时返回 null，由调用方决定提示方式，这里不代它决定。
   */
  async read(userId: number, id: string): Promise<LoadedFile | null> {
    const [rows] = await this.pool.execute<FileRow[]>(
      'SELECT id, name, ext, mime, size, created_at FROM files WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId],
    );
    const row = rows[0];
    if (!row) return null;

    const file = toStoredFile(row);
    const bytes = await fs.readFile(path.join(this.userDir(userId), `${file.id}.${file.ext}`));
    return { file, bytes };
  }

  /** 按 ID 集合批量取元数据（仅限该用户）：用于校验附件归属，也用于向模型列出本轮附件 */
  async list(userId: number, ids: string[]): Promise<StoredFile[]> {
    if (ids.length === 0) return [];
    // 占位符要按个数展开：IN 里的每个 ? 都对应一个标量参数，传数组进不去
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await this.pool.execute<FileRow[]>(
      `SELECT id, name, ext, mime, size, created_at FROM files
        WHERE user_id = ? AND id IN (${placeholders})`,
      [userId, ...ids],
    );
    return rows.map(toStoredFile);
  }
}
