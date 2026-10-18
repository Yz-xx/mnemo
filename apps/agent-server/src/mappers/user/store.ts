import type { CountRow, NameRow, StatsRow, UserRow } from './rows.js';
import type {
  SuperAdminBootstrap,
  UserListScope,
  UserPage,
  UserPatch,
  UserQuery,
  UserRecord,
  UserRole,
  UserStats,
} from '../../entities/user.js';
import type { DbPool } from '../../infrastructure/db/pool.js';
import { ADMIN_ROLES } from '../../entities/user.js';
import { hashPassword, verifyPassword } from '../../infrastructure/auth/passwordHash.js';
import { toRecord, USER_COLUMNS } from './rows.js';

/** 用户表读写：密码统一以 scrypt 哈希入库，明文既不落库也不进日志 */
export class UserStore {
  constructor(private readonly pool: DbPool) {}

  /**
   * 注册新用户；用户名已被占用时返回 null。
   * 缺省角色固定为 user——客户端注册不产出后台账号，后台账号只能由超管在用户管理里创建。
   * 原先「空库首个注册者自动成为管理员」的自举已删除：它让任何先到者都能拿到后台权限。
   */
  async register(
    username: string,
    password: string,
    role: UserRole = 'user',
  ): Promise<UserRecord | null> {
    // ON CONFLICT DO NOTHING 顶掉 MySQL 的 INSERT IGNORE：命中唯一约束时不报错、不返回行
    const { rows, rowCount } = await this.pool.query<{ id: number }>(
      `INSERT INTO users (username, password, role, status, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [username, hashPassword(password), role, 'active', new Date()],
    );
    if (rowCount === 0 || !rows[0]) return null;
    return {
      id: Number(rows[0].id),
      username,
      role,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 超管自举：库中没有任何后台侧账号时创建一枚超管，已有则原样跳过（不覆盖、不新增）。
   * 每个新库都需要一枚初始超管，否则只能靠运维超级令牌手工改库才能开启后台。
   */
  async ensureSuperAdmin(username: string, password: string): Promise<SuperAdminBootstrap> {
    const placeholders = ADMIN_ROLES.map((_, index) => `$${index + 1}`).join(', ');
    const { rows } = await this.pool.query<CountRow>(
      `SELECT COUNT(*) AS total FROM users WHERE role IN (${placeholders})`,
      [...ADMIN_ROLES],
    );
    if (Number(rows[0]?.total ?? 0) > 0) return 'skipped';
    // 用户名可能已被某个客户端账号占用，此时超管建不出来，调用方需要告警
    const { rowCount } = await this.pool.query(
      `INSERT INTO users (username, password, role, status, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO NOTHING`,
      [username, hashPassword(password), 'super_admin', 'active', new Date()],
    );
    return (rowCount ?? 0) > 0 ? 'created' : 'username-taken';
  }

  /** 登录校验：比对口令哈希 */
  async authenticate(username: string, password: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS}, password FROM users WHERE username = $1 LIMIT 1`,
      [username],
    );
    const row = rows[0];
    if (!row) return null;
    if (!verifyPassword(password, row.password)) return null;
    return toRecord(row);
  }

  /** 按 ID 查询用户：既用于凭令牌恢复登录态，也是管理端鉴权判定角色与状态的依据 */
  async findById(id: number): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`,
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
    // 只拼占位符个数与序号，取值仍走绑定参数
    const placeholders = unique.map((_, index) => `$${index + 1}`).join(', ');
    const { rows } = await this.pool.query<NameRow>(
      `SELECT id, username FROM users WHERE id IN (${placeholders})`,
      unique,
    );
    return new Map(rows.map((row) => [Number(row.id), row.username]));
  }

  /** 管理端列表：按用户名包含匹配 + 分页；用 strpos 免去对 % / _ 通配符的转义 */
  async list(query: UserQuery, scope: UserListScope = 'all'): Promise<UserPage> {
    const { keyword, page, pageSize } = query;
    // 可见范围写进 SQL 而不是取回整页后再裁剪：否则普通管理员看到的每页条数与总数都对不上
    const scopeClause = scope === 'client' ? "role = 'user' AND " : '';
    const { rows: countRows } = await this.pool.query<CountRow>(
      `SELECT COUNT(*) AS total FROM users WHERE ${scopeClause}strpos(username, $1) > 0`,
      [keyword],
    );
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users
        WHERE ${scopeClause}strpos(username, $1) > 0
        ORDER BY id DESC
        LIMIT $2 OFFSET $3`,
      [keyword, pageSize, (page - 1) * pageSize],
    );
    return { items: rows.map(toRecord), total: Number(countRows[0]?.total ?? 0) };
  }

  /** 管理端变更角色或状态；用户不存在时返回 null */
  async update(id: number, patch: UserPatch): Promise<UserRecord | null> {
    // 列名取自代码内的字面量而非请求体，可以拼接；取值仍走绑定参数
    const assignments: string[] = [];
    const params: (string | number)[] = [];
    if (patch.role !== undefined) {
      params.push(patch.role);
      assignments.push(`role = $${params.length}`);
    }
    if (patch.status !== undefined) {
      params.push(patch.status);
      assignments.push(`status = $${params.length}`);
    }
    if (assignments.length > 0) {
      params.push(id);
      await this.pool.query(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = $${params.length}`,
        params,
      );
    }
    return this.findById(id);
  }

  /** 删除账号；其会话、对话与文件由调用方先行清理，这里只动 users 表 */
  async remove(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM users WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  /** 账号汇总：总数与活跃/停用/后台账号三项计数；admins 含超管与管理员 */
  async stats(): Promise<UserStats> {
    const { rows } = await this.pool.query<StatsRow>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) AS banned,
              SUM(CASE WHEN role IN ('super_admin', 'admin') THEN 1 ELSE 0 END) AS admins
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
   * 可登录的后台账号数量：自锁规则据此判定「最后一名后台账号」。
   * 只数 active——被停用的账号进不了后台，不该占用这个保底名额。
   */
  async countActiveAdmins(): Promise<number> {
    const { rows } = await this.pool.query<CountRow>(
      `SELECT COUNT(*) AS total FROM users
        WHERE role IN ('super_admin', 'admin') AND status = 'active'`,
    );
    return Number(rows[0]?.total ?? 0);
  }
}
