import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import type { MysqlConfig } from '../config.js';

/** 创建连接池：复用连接，避免每次查询都重新握手 */
export function createMysqlPool(config: MysqlConfig): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4_unicode_ci',
    // DATETIME 按本地时区读写，保证与 JS Date 的转换结果一致
    timezone: 'local',
  });
}
