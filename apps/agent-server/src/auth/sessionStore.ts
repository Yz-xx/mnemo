import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';

/** 登录有效期：7 天，超时后需重新登录 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionRow extends RowDataPacket {
  user_id: number;
  expires_at: Date;
}

/**
 * 登录会话：令牌落库，便于服务端主动失效（登出）与过期校验。
 * 采用单端登录：每个账号同时只保留一条有效会话，新登录会顶掉该账号的旧会话。
 */
export class SessionStore {
  constructor(private readonly pool: Pool) {}

  /** 签发令牌：先清除该账号全部旧会话，保证同一账号任意时刻只存在一条登录记录 */
  async create(userId: number): Promise<string> {
    const token = randomUUID();
    const now = Date.now();

    // 删除旧会话与写入新令牌放在同一事务：避免中途失败时旧令牌已失效、新令牌又没落库
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
      await connection.execute(
        'INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        [token, userId, new Date(now), new Date(now + SESSION_TTL_MS)],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return token;
  }

  /** 校验令牌并返回用户 ID；令牌不存在或已过期时返回 null，过期记录顺手清除 */
  async resolve(token: string): Promise<number | null> {
    const [rows] = await this.pool.execute<SessionRow[]>(
      'SELECT user_id, expires_at FROM user_sessions WHERE token = ? LIMIT 1',
      [token],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at.getTime() <= Date.now()) {
      await this.remove(token);
      return null;
    }
    return Number(row.user_id);
  }

  async remove(token: string): Promise<void> {
    await this.pool.execute('DELETE FROM user_sessions WHERE token = ?', [token]);
  }

  /** 删除某账号的全部会话：账号被删除时一并清理，避免残留可用的登录态 */
  async removeAllByUser(userId: number): Promise<void> {
    await this.pool.execute('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
  }

  /**
   * 启动清理：先删过期会话，再对同一账号的历史重复会话仅保留最新一条。
   * 早期版本每次登录都新增记录，库里可能残留同一账号的多条会话，这里一次性收敛为单端登录状态。
   * 返回被清理的会话条数。
   */
  async prune(): Promise<number> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // 先清理过期记录，避免过期行参与后续去重
      const [expired] = await connection.execute<ResultSetHeader>(
        'DELETE FROM user_sessions WHERE expires_at <= ?',
        [new Date()],
      );
      // 自连接删除：保留每个账号 created_at 最新的一条；时间相同时用 token 兜底比较，保证结果确定
      // 该语句为固定 SQL 且多表 DELETE 不便走预处理协议，故使用 query
      const [duplicated] = await connection.query<ResultSetHeader>(
        `DELETE s FROM user_sessions AS s
           JOIN user_sessions AS k
             ON k.user_id = s.user_id
            AND (k.created_at > s.created_at
                 OR (k.created_at = s.created_at AND k.token > s.token))`,
      );
      await connection.commit();
      return expired.affectedRows + duplicated.affectedRows;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
