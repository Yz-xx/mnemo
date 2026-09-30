import type { MysqlConfig } from '../../configuration/config/index.js';
import { ensureColumns } from './columns.js';
import { migrateUserRoles } from './roles.js';
import { connect, ensureDatabase, ensureTables } from './tables.js';

export { ensureDatabase, ensureTables, ensureColumns };

/** 启动时保证库与表存在：先建库再建表，再补齐存量表的新增列，最后迁移存量角色 */
export async function ensureSchema(config: MysqlConfig): Promise<void> {
  await ensureDatabase(config);
  await ensureTables(config);
  await ensureColumns(config);
  const connection = await connect(config, config.database);
  try {
    await migrateUserRoles(connection, config.database);
  } finally {
    await connection.end();
  }
}
