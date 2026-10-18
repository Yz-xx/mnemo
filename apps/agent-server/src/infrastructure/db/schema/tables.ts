import type { PostgresConfig } from '../../../configuration/config/index.js';
import { Client } from 'pg';

/**
 * 角色值域：建表 CHECK 约束与存量迁移共用同一份，避免两处各写一份后漂移。
 * MySQL 的 ENUM 在 PG 里由 varchar + CHECK 表达（见 docs/adr/0012 B1）。
 */
const ROLE_VALUES = ['super_admin', 'admin', 'user'] as const;
export const ROLE_CHECK = `role IN (${ROLE_VALUES.map((role) => `'${role}'`).join(', ')})`;

/** 维护库：建目标库时必须先连到某个已存在的库，PG 没有「只连服务器」这回事 */
const MAINTENANCE_DATABASE = 'postgres';

/** 建表语句：全部 IF NOT EXISTS，可重复执行。索引单独成条——PG 不允许在 CREATE TABLE 内定义索引 */
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username varchar(64) NOT NULL UNIQUE,
    password varchar(128) NOT NULL,
    role varchar(16) NOT NULL DEFAULT 'user',
    status varchar(16) NOT NULL DEFAULT 'active',
    created_at timestamptz(3) NOT NULL,
    CONSTRAINT ck_users_role CHECK (${ROLE_CHECK}),
    CONSTRAINT ck_users_status CHECK (status IN ('active', 'banned'))
  )`,

  `CREATE TABLE IF NOT EXISTS user_sessions (
    token uuid PRIMARY KEY,
    user_id bigint NOT NULL CHECK (user_id >= 0),
    created_at timestamptz(3) NOT NULL,
    expires_at timestamptz(3) NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS conversations (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL CHECK (user_id >= 0),
    title varchar(128) NOT NULL,
    summary text NULL,
    summary_upto_seq bigint NULL CHECK (summary_upto_seq >= 0),
    created_at timestamptz(3) NOT NULL,
    updated_at timestamptz(3) NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    seq bigint GENERATED ALWAYS AS IDENTITY,
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role varchar(16) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content text NOT NULL,
    tools jsonb NULL,
    attachments jsonb NULL,
    sources jsonb NULL,
    created_at timestamptz(3) NOT NULL,
    CONSTRAINT uk_messages_seq UNIQUE (seq)
  )`,

  `CREATE TABLE IF NOT EXISTS files (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL CHECK (user_id >= 0),
    name varchar(255) NOT NULL,
    ext varchar(16) NOT NULL,
    mime varchar(128) NOT NULL,
    size bigint NOT NULL CHECK (size >= 0),
    created_at timestamptz(3) NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS api_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id varchar(8) NOT NULL,
    method varchar(8) NOT NULL,
    path varchar(255) NOT NULL,
    status integer NOT NULL CHECK (status >= 0),
    duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
    user_id bigint NULL CHECK (user_id >= 0),
    query_params text NULL,
    request_body text NULL,
    response_body text NULL,
    error text NULL,
    created_at timestamptz(3) NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id bigint NULL CHECK (actor_id >= 0),
    method varchar(8) NOT NULL,
    path varchar(255) NOT NULL,
    status integer NOT NULL CHECK (status >= 0),
    detail text NULL,
    created_at timestamptz(3) NOT NULL
  )`,
];

/** 常规索引：IF NOT EXISTS 幂等 */
const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id)',
  'CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_files_user ON files (user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_api_logs_path ON api_logs (path, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC)',
];

/** 库名白名单：库名要拼进 CREATE DATABASE，不能走绑定参数，故拼前校验 */
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 开一次性连接：指定 database 时连到目标库，否则连到配置里的库（建库要走 MAINTENANCE_DATABASE） */
export async function connect(config: PostgresConfig, database?: string): Promise<Client> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: database ?? config.database,
  });
  await client.connect();
  return client;
}

/**
 * 建库：连到维护库后执行 CREATE DATABASE。
 * 库名不能参数化，改以白名单正则校验后用双引号包裹，杜绝注入；PG 无 IF NOT EXISTS，
 * 已存在（42P04）按正常情形吞掉，其余错误照常抛出（见 docs/adr/0012 B4）。
 */
export async function ensureDatabase(config: PostgresConfig): Promise<void> {
  if (!DATABASE_NAME.test(config.database)) {
    throw new Error(`库名非法（只允许字母、数字与下划线）：${config.database}`);
  }
  const client = await connect(config, MAINTENANCE_DATABASE);
  try {
    await client.query(`CREATE DATABASE "${config.database}"`);
  } catch (error) {
    if ((error as { code?: string }).code !== '42P04') throw error;
  } finally {
    await client.end();
  }
}

/** 建表与索引：连到目标库后依次执行，全部 IF NOT EXISTS */
export async function ensureTables(config: PostgresConfig): Promise<void> {
  const client = await connect(config);
  try {
    for (const statement of [...CREATE_TABLES, ...CREATE_INDEXES]) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}
