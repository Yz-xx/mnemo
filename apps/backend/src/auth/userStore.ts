import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { desEncrypt } from '@repo/shared';

/** 对外返回的用户信息：不包含密码字段 */
export interface UserRecord {
  id: number;
  username: string;
  createdAt: string;
}

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  password: string;
  created_at: Date;
}

function toRecord(row: UserRow): UserRecord {
  return { id: Number(row.id), username: row.username, createdAt: row.created_at.toISOString() };
}

/** 用户表读写：密码统一以 shared 的 DES 密文入库，不保存明文 */
export class UserStore {
  constructor(private readonly pool: Pool) {}

  /** 注册新用户；用户名已被占用时返回 null */
  async register(username: string, password: string): Promise<UserRecord | null> {
    // INSERT IGNORE 命中用户名唯一索引时不会报错，affectedRows 为 0
    const [result] = await this.pool.execute<ResultSetHeader>(
      'INSERT IGNORE INTO users (username, password, created_at) VALUES (?, ?, ?)',
      [username, desEncrypt(password), new Date()],
    );
    if (result.affectedRows === 0) return null;
    return { id: result.insertId, username, createdAt: new Date().toISOString() };
  }

  /** 登录校验：DES 为定值加密，直接比对我们存储的密文即可，无需解密 */
  async authenticate(username: string, password: string): Promise<UserRecord | null> {
    const [rows] = await this.pool.execute<UserRow[]>(
      'SELECT id, username, password, created_at FROM users WHERE username = ? LIMIT 1',
      [username],
    );
    const row = rows[0];
    if (!row || row.password !== desEncrypt(password)) return null;
    return toRecord(row);
  }

  /** 按 ID 查询用户，用于根据令牌恢复登录态 */
  async findById(id: number): Promise<UserRecord | null> {
    const [rows] = await this.pool.execute<UserRow[]>(
      'SELECT id, username, password, created_at FROM users WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
