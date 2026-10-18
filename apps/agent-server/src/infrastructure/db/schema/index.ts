import type { PostgresConfig } from '../../../configuration/config/index.js';
import { migrateUserRoles } from './roles.js';
import { connect, ensureDatabase, ensureTables } from './tables.js';

export { ensureDatabase, ensureTables };

/**
 * 启动时保证库与表存在：先建库再建表，最后迁移存量角色。
 * 存量补列（原 columns.ts）已删除：PG 的 `ADD COLUMN IF NOT EXISTS` 让建表语句自身幂等，
 * 新列直接写进 CREATE TABLE 即可，无需另起一套「查 information_schema 再补列」的逻辑（见 docs/adr/0012 B4）。
 */
export async function ensureSchema(config: PostgresConfig): Promise<void> {
  await ensureDatabase(config);
  await ensureTables(config);
  const client = await connect(config);
  try {
    await migrateUserRoles(client);
  } finally {
    await client.end();
  }
}
