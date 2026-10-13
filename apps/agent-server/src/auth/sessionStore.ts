import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';

/** 登录有效期：7 天，超时后需重新登录 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionRow extends RowDataPacket {
  user_id: number;
  expires_at: Date;
}

/** 缓存项：命中后直接返回用户 ID，省掉一次 user_sessions 查询 */
interface CachedSession {
  userId: number;
  /** 该缓存项的失效时刻（毫秒时间戳） */
  expiresAt: number;
}

/**
 * 登录会话：令牌落库，便于服务端主动失效（登出）与过期校验。
 * 采用单端登录：每个账号同时只保留一条有效会话，新登录会顶掉该账号的旧会话。
 *
 * 校验结果做短 TTL 缓存（见 docs/adr/0010 决策 13）：鉴权每请求一次，命中缓存即省下这次查询。
 * 登出、重新登录、删号都会主动清缓存，TTL 只兜住被动变化（如会话过期），不放大失效窗口。
 */
export class SessionStore {
  private readonly cache = new Map<string, CachedSession>();

  constructor(
    private readonly pool: Pool,
    private readonly cacheTtlMs: number,
  ) {}

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

    // 该账号旧会话已被删除，缓存里的旧令牌必须一起失效，否则它们仍能命中缓存继续放行
    this.evictUser(userId);
    return token;
  }

  /** 校验令牌并返回用户 ID；令牌不存在或已过期时返回 null，过期记录顺手清除 */
  async resolve(token: string): Promise<number | null> {
    const cached = this.cache.get(token);
    if (cached) {
      if (cached.expiresAt > Date.now()) return cached.userId;
      this.cache.delete(token);
    }

    const [rows] = await this.pool.execute<SessionRow[]>(
      'SELECT user_id, expires_at FROM user_sessions WHERE token = ? LIMIT 1',
      [token],
    );
    const row = rows[0];
    if (!row) return null;
    const sessionExpiry = row.expires_at.getTime();
    if (sessionExpiry <= Date.now()) {
      await this.remove(token);
      return null;
    }
    const userId = Number(row.user_id);
    // 缓存有效期取「会话剩余有效期」与「短 TTL」的较小者：既不越过会话本身，也不长于约定的短窗口
    this.cache.set(token, {
      userId,
      expiresAt: Math.min(sessionExpiry, Date.now() + this.cacheTtlMs),
    });
    return userId;
  }

  /** 删除单个令牌的会话：一并清掉其缓存项，避免登出后旧令牌仍命中缓存继续放行 */
  async remove(token: string): Promise<void> {
    this.cache.delete(token);
    await this.pool.execute('DELETE FROM user_sessions WHERE token = ?', [token]);
  }

  /** 删除某账号的全部会话：账号被删除时一并清理，避免残留可用的登录态 */
  async removeAllByUser(userId: number): Promise<void> {
    this.evictUser(userId);
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
      // 库里会话已被收敛，缓存里的映射可能已不对应现存记录，整表清空最稳妥
      this.cache.clear();
      return expired.affectedRows + duplicated.affectedRows;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /** 清掉某账号的全部缓存项：该账号的会话被清空或顶替后，旧令牌不得再命中缓存 */
  private evictUser(userId: number): void {
    for (const [token, cached] of this.cache) {
      if (cached.userId === userId) this.cache.delete(token);
    }
  }
}
