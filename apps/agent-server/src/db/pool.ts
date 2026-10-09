import type { MysqlConfig } from '../configuration/config/index.js';
import type { Pool } from 'mysql2/promise';
import mysql from 'mysql2/promise';

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
    // 池满后的等待队列有界：排满即失败，而不是让请求排到队时客户端早已离开
    queueLimit: config.queueLimit,
    // 建连超时：MySQL 不可达时尽快失败，避免请求一直挂在握手上
    connectTimeout: config.connectTimeoutMs,
    charset: 'utf8mb4_unicode_ci',
    // DATETIME 按本地时区读写，保证与 JS Date 的转换结果一致
    timezone: 'local',
  });
}
