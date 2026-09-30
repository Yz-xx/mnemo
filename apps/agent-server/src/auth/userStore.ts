import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { hashPassword, verifyPassword } from './passwordHash.js';

/** 角色：admin 可登录管理后台，user 仅能使用客户端 */
export type UserRole = 'admin' | 'user';

/** 账号状态：banned 表示禁止登录，历史数据仍保留以便审计 */
export type UserStatus = 'active' | 'banned';

/** 对外返回的用户信息：不包含密码字段 */
export interface UserRecord {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

/** 管理端列表查询条件：keyword 按用户名包含匹配，分页参数已在路由层收敛 */
export interface UserQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 用户分页结果：total 为满足条件的总数，供前端计算总页数 */
export interface UserPage {
  items: UserRecord[];
  total: number;
}

/** 账号汇总：一条聚合查询取回四个计数，避免总览为每项各发一次请求 */
export interface UserStats {
  total: number;
  active: number;
  banned: number;
  admins: number;
}

/** 管理员可变更的字段：未传的字段保持原值 */
export interface UserPatch {
  role?: UserRole;
  status?: UserStatus;
}

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  password: string;
  role: UserRole;
  status: UserStatus;
  created_at: Date;
}

interface CountRow extends RowDataPacket {
  total: number;
}

/** 只取昵称列的行：知识库列表按 ID 批量还原账号名，不需要完整用户字段 */
interface NameRow extends RowDataPacket {
  id: number;
  username: string;
}

interface StatsRow extends RowDataPacket {
  total: number;
  active: number;
  banned: number;
  admins: number;
}

/** 列表与单条查询共用的列集合：不带 password，避免密文被带到上层 */
const USER_COLUMNS = 'id, username, role, status, created_at';

function toRecord(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/** 用户表读写：密码统一以 scrypt 哈希入库，明文既不落库也不进日志 */
export class UserStore {
  constructor(private readonly pool: Pool) {}

  /**
   * 注册新用户；用户名已被占用时返回 null。
   * 库中尚无任何账号时把首个用户设为管理员：管理后台需要一枚初始管理员，
   * 否则只能靠运维超级令牌（x-admin-token）手工改库才能开启，这里让自举自动完成。
   * 管理端新建用户会显式传入 role，不受该规则影响。
   */
  async register(username: string, password: string, role?: UserRole): Promise<UserRecord | null> {
    const [existing] = await this.pool.query<UserRow[]>('SELECT id FROM users LIMIT 1');
    const assigned: UserRole = role ?? (existing.length > 0 ? 'user' : 'admin');
    // INSERT IGNORE 命中用户名唯一索引时不会报错，affectedRows 为 0
    const [result] = await this.pool.execute<ResultSetHeader>(
      'INSERT IGNORE INTO users (username, password, role, status, created_at) VALUES (?, ?, ?, ?, ?)',
      [username, hashPassword(password), assigned, 'active', new Date()],
    );
    if (result.affectedRows === 0) return null;
    return {
      id: result.insertId,
      username,
      role: assigned,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
  }

  /** 登录校验：比对口令哈希；命中历史 DES 密文时就地升级为哈希 */
  async authenticate(username: string, password: string): Promise<UserRecord | null> {
    const [rows] = await this.pool.execute<UserRow[]>(
      `SELECT ${USER_COLUMNS}, password FROM users WHERE username = ? LIMIT 1`,
      [username],
    );
    const row = rows[0];
    if (!row) return null;
    const check = verifyPassword(password, row.password);
    if (!check.ok) return null;
    // 旧数据是定值 DES 密文：此刻手里正好有明文，顺手换成哈希，账号无需重置密码
    if (check.legacy) {
      await this.pool.execute('UPDATE users SET password = ? WHERE id = ?', [
        hashPassword(password),
        row.id,
      ]);
    }
    return toRecord(row);
  }

  /** 按 ID 查询用户：既用于凭令牌恢复登录态，也是管理端鉴权判定角色与状态的依据 */
  async findById(id: number): Promise<UserRecord | null> {
    const [rows] = await this.pool.execute<UserRow[]>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * 按 ID 批量取用户名：知识库列表要把 owner_user_id 还原成可读账号名，
   * 逐条查会让一页列表产生 N 次往返，故用一次 IN 查询取回。
   */
  async findNamesByIds(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (unique.length === 0) return new Map();
    // 只拼占位符个数，取值仍走参数：execute 的预处理语句不支持把数组展开成多个占位
    const placeholders = unique.map(() => '?').join(', ');
    const [rows] = await this.pool.execute<NameRow[]>(
      `SELECT id, username FROM users WHERE id IN (${placeholders})`,
      unique,
    );
    return new Map(rows.map((row) => [Number(row.id), row.username]));
  }

  /** 管理端列表：按用户名包含匹配 + 分页；用 LOCATE 免去对 % / _ 通配符的转义 */
  async list(query: UserQuery): Promise<UserPage> {
    const { keyword, page, pageSize } = query;
    const [countRows] = await this.pool.execute<CountRow[]>(
      'SELECT COUNT(*) AS total FROM users WHERE LOCATE(?, username) > 0',
      [keyword],
    );
    const [rows] = await this.pool.execute<UserRow[]>(
      `SELECT ${USER_COLUMNS} FROM users
        WHERE LOCATE(?, username) > 0
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [keyword, pageSize, (page - 1) * pageSize],
    );
    return { items: rows.map(toRecord), total: Number(countRows[0]?.total ?? 0) };
  }

  /** 管理端变更角色或状态；用户不存在时返回 null */
  async update(id: number, patch: UserPatch): Promise<UserRecord | null> {
    // 列名取自代码内的字面量而非请求体，可以拼接；取值仍走占位符
    const assignments: string[] = [];
    const params: (string | number)[] = [];
    if (patch.role !== undefined) {
      assignments.push('role = ?');
      params.push(patch.role);
    }
    if (patch.status !== undefined) {
      assignments.push('status = ?');
      params.push(patch.status);
    }
    if (assignments.length > 0) {
      await this.pool.execute(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, [
        ...params,
        id,
      ]);
    }
    return this.findById(id);
  }

  /** 删除账号；其会话、对话与文件由调用方先行清理，这里只动 users 表 */
  async remove(id: number): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>('DELETE FROM users WHERE id = ?', [
      id,
    ]);
    return result.affectedRows > 0;
  }

  /** 账号汇总：总数与活跃/停用/管理员三项计数 */
  async stats(): Promise<UserStats> {
    const [rows] = await this.pool.execute<StatsRow[]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) AS banned,
              SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins
         FROM users`,
    );
    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      active: Number(row?.active ?? 0),
      banned: Number(row?.banned ?? 0),
      admins: Number(row?.admins ?? 0),
    };
  }

  /**
   * 可登录的管理员数量：自锁规则据此判定「最后一名管理员」。
   * 只数 active——被停用的管理员进不了后台，不该占用这个保底名额。
   */
  async countActiveAdmins(): Promise<number> {
    const [rows] = await this.pool.execute<CountRow[]>(
      "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'",
    );
    return Number(rows[0]?.total ?? 0);
  }
}
