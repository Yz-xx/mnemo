import type { Client } from 'pg';
import { ROLE_CHECK } from './tables.js';

/** 角色约束名：重建 CHECK 与查重共用同一个名字 */
const ROLE_CONSTRAINT = 'ck_users_role';

/** 约束定义行：pg_get_constraintdef 返回的是形如 CHECK ((role = ANY (...))) 的原文 */
interface ConstraintRow {
  definition: string;
}

/** 角色计数行：两个计数合并成一次查询，字段名用别名区分 */
interface RoleCountRow {
  super_admins: number;
  admins: number;
}

/**
 * 存量角色迁移：把 role 由两值扩为三值，并把既有的 admin 账号提升为 super_admin。
 *
 * 扩列与提权分开判定、各自幂等，不能共用一个「已处理过」的开关：
 * ALTER 是 DDL，若以「约束定义已含 super_admin」兼作提权判据，
 * 一旦两条语句之间中断，下次启动就会提前返回，存量 admin 永远提不成超管。
 * MySQL 的 MODIFY COLUMN 要重建整表，PG 只需重建 CHECK 约束，代价更低（见 docs/adr/0012 B4）。
 */
export async function migrateUserRoles(client: Client): Promise<void> {
  const { rows } = await client.query<ConstraintRow>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = $1 AND conrelid = 'users'::regclass`,
    [ROLE_CONSTRAINT],
  );
  if (!(rows[0]?.definition ?? '').includes("'super_admin'")) {
    // 先删后加：两步都幂等，中断后下次启动可重来
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS ${ROLE_CONSTRAINT}`);
    await client.query(`ALTER TABLE users ADD CONSTRAINT ${ROLE_CONSTRAINT} CHECK (${ROLE_CHECK})`);
  }

  // 提权判据只看数据：库里一枚超管都没有、却还留着普通 admin 时才补提。
  // 这样中断后可自愈；而新模型下刻意保留的普通 admin（库里已有超管）不会被误提。
  const { rows: counts } = await client.query<RoleCountRow>(
    `SELECT COUNT(*) FILTER (WHERE role = 'super_admin') AS super_admins,
            COUNT(*) FILTER (WHERE role = 'admin') AS admins
       FROM users`,
  );
  const hasSuperAdmin = Number(counts[0]?.super_admins ?? 0) > 0;
  const hasAdmin = Number(counts[0]?.admins ?? 0) > 0;
  if (!hasSuperAdmin && hasAdmin) {
    await client.query("UPDATE users SET role = 'super_admin' WHERE role = 'admin'");
  }
}
