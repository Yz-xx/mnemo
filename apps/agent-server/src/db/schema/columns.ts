import type { MysqlConfig } from '../../configuration/config/index.js';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import mysql from 'mysql2/promise';
import { connect, ROLE_COLUMN_DEFINITION } from './tables.js';

/** 补列项：name 用于查重，definition 是 ADD COLUMN 之后的完整列定义（含 COMMENT 与 AFTER 定位） */
interface ColumnMigration {
  name: string;
  definition: string;
}

/**
 * 存量表的补列清单：新增列时在此登记。
 * CREATE TABLE IF NOT EXISTS 不修改已存在的表结构，老库只能靠这里补，故每项都必须幂等。
 */
const COLUMN_MIGRATIONS: Record<string, ColumnMigration[]> = {
  users: [
    {
      name: 'role',
      definition: `role ${ROLE_COLUMN_DEFINITION} AFTER password`,
    },
    {
      name: 'status',
      definition: `status ENUM('active', 'banned') NOT NULL DEFAULT 'active'
        COMMENT '账号状态：banned 禁止登录' AFTER role`,
    },
  ],
  conversations: [
    {
      name: 'summary',
      definition: `summary TEXT NULL COMMENT '滚动摘要：保留窗口之前的对话压缩结果'
        AFTER title`,
    },
    {
      name: 'summary_upto_seq',
      definition: `summary_upto_seq BIGINT UNSIGNED NULL
        COMMENT '摘要已覆盖到的消息自增序号，即截断点' AFTER summary`,
    },
  ],
  messages: [
    {
      name: 'tools',
      definition: `tools JSON NULL COMMENT '助手本轮调用过的工具名数组，历史回看时还原工具标签'
        AFTER content`,
    },
    {
      name: 'attachments',
      definition: `attachments JSON NULL COMMENT '用户提问附带的文件名数组，历史回看时还原附件标签'
        AFTER tools`,
    },
    {
      name: 'sources',
      definition: `sources JSON NULL COMMENT '助手本轮检索命中的知识库文档名数组，历史回看时还原来源标签'
        AFTER attachments`,
    },
  ],
};

/** 读取某表已存在的列名 */
async function readColumns(
  connection: Connection,
  database: string,
  table: string,
): Promise<Set<string>> {
  // 别名 AS name 是必须的：information_schema 里该列的定义名是 COLUMN_NAME，
  // 结果对象的键会跟着定义名走（大写），按小写 column_name 取值恒为 undefined，
  // 于是每次都误判“列不存在”，对已有该列的表重复 ALTER 并报 Duplicate column name
  interface ColumnRow extends RowDataPacket {
    name: string;
  }
  const [rows] = await connection.query<ColumnRow[]>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?`,
    [database, table],
  );
  return new Set(rows.map((row) => row.name));
}

/** 按需补列：只对缺失的列执行 ALTER，避免低版本 MySQL 不支持 ADD COLUMN IF NOT EXISTS 而报错 */
async function ensureTableColumns(
  connection: Connection,
  database: string,
  table: string,
  migrations: ColumnMigration[],
): Promise<void> {
  const existing = await readColumns(connection, database, table);
  for (const migration of migrations) {
    if (existing.has(migration.name)) continue;
    await connection.query(
      `ALTER TABLE ${mysql.escapeId(table)} ADD COLUMN ${migration.definition}`,
    );
  }
}

/** 按登记表逐张补齐存量表的新增列，幂等可重复执行 */
export async function ensureColumns(config: MysqlConfig): Promise<void> {
  const connection = await connect(config, config.database);
  try {
    for (const [table, migrations] of Object.entries(COLUMN_MIGRATIONS)) {
      await ensureTableColumns(connection, config.database, table, migrations);
    }
  } finally {
    await connection.end();
  }
}
