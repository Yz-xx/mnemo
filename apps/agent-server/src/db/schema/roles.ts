import type { Connection, RowDataPacket } from 'mysql2/promise';
import { ROLE_COLUMN_DEFINITION } from './tables.js';

/** 列类型行：查 information_schema 时必须起别名，理由见 columns.ts 的 readColumns */
interface RoleColumnRow extends RowDataPacket {
  type: string;
}

/** 角色计数行：两个不同的行类型合并成一次查询，字段名用别名区分 */
interface RoleCountRow extends RowDataPacket {
  super_admins: number;
  admins: number;
}

/**
 * 存量角色迁移：把 role 由两值扩为三值，并把既有的 admin 账号提升为 super_admin。
 *
 * 扩列与提权分开判定、各自幂等，不能共用一个「已处理过」的开关：
 * ALTER 是 DDL，会隐式提交，若以「列定义已含 super_admin」兼作提权判据，
 * 一旦两条语句之间中断，下次启动就会提前返回，存量 admin 永远提不成超管。
 */
export async function migrateUserRoles(connection: Connection, database: string): Promise<void> {
  const [columns] = await connection.query<RoleColumnRow[]>(
    `SELECT column_type AS type FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'users' AND column_name = 'role'`,
    [database],
  );
  if (!(columns[0]?.type ?? '').includes('super_admin')) {
    // MODIFY COLUMN 会重建 users 表，故只在新旧模型切换的那一次执行
    await connection.query(`ALTER TABLE users MODIFY COLUMN role ${ROLE_COLUMN_DEFINITION}`);
  }

  // 提权判据只看数据：库里一枚超管都没有、却还留着普通 admin 时才补提。
  // 这样中断后可自愈；而新模型下刻意保留的普通 admin（库里已有超管）不会被误提。
  const [counts] = await connection.query<RoleCountRow[]>(
    `SELECT COUNT(*) AS super_admins, SUM(role = 'admin') AS admins FROM users`,
  );
  const hasSuperAdmin = Number(counts[0]?.super_admins ?? 0) > 0;
  const hasAdmin = Number(counts[0]?.admins ?? 0) > 0;
  if (!hasSuperAdmin && hasAdmin) {
    await connection.query("UPDATE users SET role = 'super_admin' WHERE role = 'admin'");
  }
}
