import type { MysqlConfig } from '../configuration/config/index.js';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import mysql from 'mysql2/promise';

/** 建表语句：全部使用 IF NOT EXISTS，可重复执行 */
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '用户 ID',
    username VARCHAR(64) NOT NULL COMMENT '登录名',
    password VARCHAR(128) NOT NULL COMMENT '口令哈希（scrypt$盐hex$散列hex）',
    role ENUM('admin', 'user') NOT NULL DEFAULT 'user' COMMENT '角色：admin 可登录管理后台',
    status ENUM('active', 'banned') NOT NULL DEFAULT 'active' COMMENT '账号状态：banned 禁止登录',
    created_at DATETIME(3) NOT NULL COMMENT '注册时间',
    PRIMARY KEY (id),
    UNIQUE KEY uk_users_username (username)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '用户表'`,

  `CREATE TABLE IF NOT EXISTS user_sessions (
    token CHAR(36) NOT NULL COMMENT '登录令牌',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '用户 ID',
    created_at DATETIME(3) NOT NULL COMMENT '签发时间',
    expires_at DATETIME(3) NOT NULL COMMENT '过期时间',
    PRIMARY KEY (token),
    KEY idx_user_sessions_user (user_id)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '登录会话表'`,

  `CREATE TABLE IF NOT EXISTS conversations (
    id CHAR(36) NOT NULL COMMENT '对话 ID',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
    title VARCHAR(128) NOT NULL COMMENT '对话标题',
    created_at DATETIME(3) NOT NULL COMMENT '创建时间',
    updated_at DATETIME(3) NOT NULL COMMENT '最近更新时间',
    PRIMARY KEY (id),
    KEY idx_conversations_user (user_id, updated_at DESC)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '对话表'`,

  `CREATE TABLE IF NOT EXISTS messages (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增序号，保证读取顺序稳定',
    id CHAR(36) NOT NULL COMMENT '消息 ID',
    conversation_id CHAR(36) NOT NULL COMMENT '所属对话',
    role ENUM('user', 'assistant', 'system') NOT NULL COMMENT '消息角色',
    content MEDIUMTEXT NOT NULL COMMENT '消息正文',
    tools JSON NULL COMMENT '助手本轮调用过的工具名数组，历史回看时还原工具标签',
    attachments JSON NULL COMMENT '用户提问附带的文件名数组，历史回看时还原附件标签',
    sources JSON NULL COMMENT '助手本轮检索命中的知识库文档名数组，历史回看时还原来源标签',
    created_at DATETIME(3) NOT NULL COMMENT '发送时间',
    PRIMARY KEY (id),
    UNIQUE KEY uk_messages_seq (seq),
    KEY idx_messages_conversation (conversation_id, seq),
    CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id)
      REFERENCES conversations (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '消息表'`,

  `CREATE TABLE IF NOT EXISTS files (
    id CHAR(36) NOT NULL COMMENT '文件 ID',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '上传者',
    name VARCHAR(255) NOT NULL COMMENT '原始文件名，仅作展示',
    ext VARCHAR(16) NOT NULL COMMENT '由 magic bytes 判定的扩展名',
    mime VARCHAR(128) NOT NULL COMMENT '由 magic bytes 判定的类型',
    size INT UNSIGNED NOT NULL COMMENT '字节数',
    created_at DATETIME(3) NOT NULL COMMENT '上传时间',
    PRIMARY KEY (id),
    KEY idx_files_user (user_id, created_at)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '上传文件元数据表'`,

  `CREATE TABLE IF NOT EXISTS api_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '日志序号，兼作时间倒序的排序键',
    request_id CHAR(8) NOT NULL COMMENT '请求 ID，与响应头 x-request-id 一致',
    method VARCHAR(8) NOT NULL COMMENT 'HTTP 方法',
    path VARCHAR(255) NOT NULL COMMENT '请求路径，不含查询串',
    status SMALLINT UNSIGNED NOT NULL COMMENT '响应状态码',
    duration_ms INT UNSIGNED NOT NULL COMMENT '处理耗时（毫秒）',
    user_id BIGINT UNSIGNED NULL COMMENT '登录用户 ID；未登录与超级令牌入口为 NULL',
    query_params TEXT NULL COMMENT '查询串摘要，已脱敏并截断',
    request_body TEXT NULL COMMENT '请求体摘要，已脱敏并截断',
    response_body TEXT NULL COMMENT '响应体摘要，已脱敏并截断',
    error TEXT NULL COMMENT '错误摘要，仅 5xx 有值',
    created_at DATETIME(3) NOT NULL COMMENT '记录时间',
    PRIMARY KEY (id),
    KEY idx_api_logs_created (created_at DESC),
    KEY idx_api_logs_path (path, created_at DESC)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '接口请求日志表'`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '序号，兼作时间倒序的排序键',
    actor_id BIGINT UNSIGNED NULL COMMENT '操作管理员 ID；经运维超级令牌进入时为 NULL',
    method VARCHAR(8) NOT NULL COMMENT 'HTTP 方法',
    path VARCHAR(255) NOT NULL COMMENT '请求路径，不含查询串',
    status SMALLINT UNSIGNED NOT NULL COMMENT '响应状态码，失败的写入尝试同样留档',
    detail TEXT NULL COMMENT '请求体摘要，已脱敏并截断',
    created_at DATETIME(3) NOT NULL COMMENT '记录时间',
    PRIMARY KEY (id),
    KEY idx_audit_logs_created (created_at DESC),
    KEY idx_audit_logs_actor (actor_id, created_at DESC)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '管理端写操作审计表'`,
];

/** 开一次性连接：不指定 database 时连到 MySQL 服务器本身，用于建库 */
function connect(config: MysqlConfig, database?: string): Promise<Connection> {
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    ...(database ? { database } : {}),
  });
}

/** 建库：库可能尚未创建，必须先连到服务器再创建，不能带 database */
export async function ensureDatabase(config: MysqlConfig): Promise<void> {
  const connection = await connect(config);
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(config.database)}
       DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await connection.end();
  }
}

/** 建表：连到目标库后依次执行建表语句 */
export async function ensureTables(config: MysqlConfig): Promise<void> {
  const connection = await connect(config, config.database);
  try {
    for (const statement of CREATE_TABLES) {
      await connection.query(statement);
    }
  } finally {
    await connection.end();
  }
}

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
      definition: `role ENUM('admin', 'user') NOT NULL DEFAULT 'user'
        COMMENT '角色：admin 可登录管理后台' AFTER password`,
    },
    {
      name: 'status',
      definition: `status ENUM('active', 'banned') NOT NULL DEFAULT 'active'
        COMMENT '账号状态：banned 禁止登录' AFTER role`,
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

/** 启动时保证库与表存在：先建库再建表，最后补齐存量表的新增列 */
export async function ensureSchema(config: MysqlConfig): Promise<void> {
  await ensureDatabase(config);
  await ensureTables(config);
  await ensureColumns(config);
}
