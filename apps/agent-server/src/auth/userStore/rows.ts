import type { UserRecord, UserRole, UserStatus } from './types.js';
import type { RowDataPacket } from 'mysql2/promise';

/** users 表的一行：只在 Store 内部使用，password 不随 UserRecord 出表 */
export interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  password: string;
  role: UserRole;
  status: UserStatus;
  created_at: Date;
}

export interface CountRow extends RowDataPacket {
  total: number;
}

/** 只取昵称列的行：知识库列表按 ID 批量还原账号名，不需要完整用户字段 */
export interface NameRow extends RowDataPacket {
  id: number;
  username: string;
}

export interface StatsRow extends RowDataPacket {
  total: number;
  active: number;
  banned: number;
  admins: number;
}

/** 列表与单条查询共用的列集合：不带 password，避免密文被带到上层 */
export const USER_COLUMNS = 'id, username, role, status, created_at';

/** 行转用户记录：只映射不含 password 的列，创建时间统一转 ISO 字符串 */
export function toRecord(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}
