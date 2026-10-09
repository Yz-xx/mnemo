import type { AdminFileRow, FileRow, TotalRow } from './mapper.js';
import type {
  AdminFilePage,
  AdminFileQuery,
  LoadedFile,
  StoredFile,
  StreamedUpload,
  UploadedFile,
} from './types.js';
import type { Pool } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toStoredFile } from './mapper.js';

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

  /** 写入元数据行：内存字节与临时文件改名的落盘方式不同，但入库列完全一致，故收在一处 */
  private async insertRow(userId: number, record: StoredFile): Promise<void> {
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
      await this.insertRow(userId, record);
    } catch (error) {
      await fs.rm(target, { force: true });
      throw error;
    }
    return record;
  }

  /**
   * 从临时文件入库：以改名（rename）代替复制，字节不再过一遍内存（见 docs/adr/0010 决策 14）。
   * 临时文件由上传中间件写在同一个上传根目录下，与正式目录同卷，改名不产生拷贝开销；
   * 元数据写失败时回删目标文件，避免留下无人引用的孤儿文件。
   */
  async saveFromPath(userId: number, upload: StreamedUpload): Promise<StoredFile> {
    const record: StoredFile = {
      id: randomUUID(),
      name: upload.name,
      ext: upload.ext,
      mime: upload.mime,
      size: upload.size,
      createdAt: new Date().toISOString(),
    };
    const dir = this.userDir(userId);
    const target = path.join(dir, `${record.id}.${record.ext}`);

    await fs.mkdir(dir, { recursive: true });
    await fs.rename(upload.tempPath, target);
    try {
      await this.insertRow(userId, record);
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

  /**
   * 删除该用户的全部文件：先删元数据再删落盘目录，避免元数据没了却留下无人引用的文件。
   * 用户可能从未上传过，目录不存在时靠 force 静默跳过。
   */
  async removeAllByUser(userId: number): Promise<void> {
    await this.pool.execute('DELETE FROM files WHERE user_id = ?', [userId]);
    await fs.rm(this.userDir(userId), { recursive: true, force: true });
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

  /**
   * 管理端列表：不按用户过滤，返回全部文件元数据与上传者 ID。
   * 与客户端 list 的区别只是「不限定 user_id」，故另立方法而不是给原方法加可选开关——
   * 归属过滤是客户端调用的默认语义，加开关会让两处调用都更难读。
   */
  async listAll(query: AdminFileQuery): Promise<AdminFilePage> {
    const { keyword, page, pageSize } = query;
    const [countRows] = await this.pool.execute<TotalRow[]>(
      'SELECT COUNT(*) AS total FROM files WHERE LOCATE(?, name) > 0',
      [keyword],
    );
    const [rows] = await this.pool.execute<AdminFileRow[]>(
      `SELECT id, user_id, name, ext, mime, size, created_at FROM files
        WHERE LOCATE(?, name) > 0
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [keyword, pageSize, (page - 1) * pageSize],
    );
    return {
      items: rows.map((row) => ({ ...toStoredFile(row), userId: Number(row.user_id) })),
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  /**
   * 删除任意文件（不限上传者）：管理端清理用。
   * 落盘路径由「上传者 ID + 文件 ID + 扩展名」拼出，因此得先查一次元数据；
   * 元数据删掉后文件即不可读，磁盘删除失败只会留下无人引用的字节，不影响正确性。
   */
  async removeAny(id: string): Promise<boolean> {
    const [rows] = await this.pool.execute<AdminFileRow[]>(
      'SELECT id, user_id, name, ext, mime, size, created_at FROM files WHERE id = ? LIMIT 1',
      [id],
    );
    const row = rows[0];
    if (!row) return false;
    await this.pool.execute('DELETE FROM files WHERE id = ?', [id]);
    await fs.rm(path.join(this.userDir(Number(row.user_id)), `${row.id}.${row.ext}`), {
      force: true,
    });
    return true;
  }
}
