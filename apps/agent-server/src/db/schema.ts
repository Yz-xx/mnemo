import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { MysqlConfig } from '../config.js';

/** 建表语句：全部使用 IF NOT EXISTS，可重复执行 */
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '用户 ID',
    username VARCHAR(64) NOT NULL COMMENT '登录名',
    password VARCHAR(128) NOT NULL COMMENT 'DES 加密后的密码',
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

/**
 * 已有表的列补齐：CREATE TABLE IF NOT EXISTS 不会修改已存在的表结构，
 * 新增列必须在这里做条件迁移。查 information_schema 判断列是否存在，
 * 避免对低版本 MySQL（不支持 ADD COLUMN IF NOT EXISTS）直接 ALTER 报错。
 */
export async function ensureColumns(config: MysqlConfig): Promise<void> {
  const connection = await connect(config, config.database);
  try {
    // 别名 AS name 是必须的：information_schema 里该列的定义名是 COLUMN_NAME，
    // 结果对象的键会跟着定义名走（大写），按小写 column_name 取值恒为 undefined，
    // 于是每次都误判“列不存在”，对已有该列的表重复 ALTER 并报 Duplicate column name
    interface ColumnRow extends RowDataPacket {
      name: string;
    }
    const [rows] = await connection.query<ColumnRow[]>(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = ? AND table_name = 'messages' AND column_name IN ('tools', 'attachments', 'sources')`,
      [config.database],
    );
    const existing = new Set(rows.map((row) => row.name));
    // 缺失哪列就补哪列，按 content 之后的顺序追加，保证与新建表的列序一致
    if (!existing.has('tools')) {
      await connection.query(
        `ALTER TABLE messages
          ADD COLUMN tools JSON NULL COMMENT '助手本轮调用过的工具名数组，历史回看时还原工具标签'
          AFTER content`,
      );
    }
    if (!existing.has('attachments')) {
      await connection.query(
        `ALTER TABLE messages
          ADD COLUMN attachments JSON NULL COMMENT '用户提问附带的文件名数组，历史回看时还原附件标签'
          AFTER tools`,
      );
    }
    if (!existing.has('sources')) {
      await connection.query(
        `ALTER TABLE messages
          ADD COLUMN sources JSON NULL COMMENT '助手本轮检索命中的知识库文档名数组，历史回看时还原来源标签'
          AFTER attachments`,
      );
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
