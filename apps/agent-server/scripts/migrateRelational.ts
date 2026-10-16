/**
 * 关系库数据搬运（见 docs/adr/0012 阶段 2 · 实施细则 B5）：
 * 停机窗口内把 MySQL 存量数据一次性导入 PostgreSQL，不做双写（ADR 决策 7）。
 *
 * 前置（三项）：
 *   1. 目标库已由应用启动流程建好（ensureDatabase + ensureTables）；本脚本只搬数据、不建表
 *   2. 目标侧 PG_* 取自 --env-file 的 .env.development；源侧 MYSQL_* 由环境变量显式给出
 *   3. 搬运期间后端已停写：脚本会先清空目标侧七张表
 *
 * 用法：pnpm --filter @repo/agent-server run migrate:relational
 * 幂等：可重复执行，每次以 MySQL 当前内容为准整体覆盖；整批一个事务，任一步失败全部回滚
 */
import type { Pool as MysqlPool } from 'mysql2/promise';
import type { PoolClient } from 'pg';
import process from 'node:process';
import { createPool } from 'mysql2/promise';
import { loadConfig } from '../src/configuration/config/index.js';
import { createPgPool } from '../src/db/pool.js';

/** 单批行数：PG 单语句绑定参数上限 65535，列数最多的是 api_logs（12 列），取远低于上限的保守值 */
const BATCH_ROWS = 1000;

/** 搬运表：名与列在两侧逐字相同，故一份清单兼作「源库读」与「目标库写」 */
interface TableSpec {
  name: string;
  columns: readonly string[];
  /** IDENTITY 列：需 OVERRIDING SYSTEM VALUE 显式带原值，写完后还要对齐序列 */
  identity?: string;
  /** jsonb 列：源侧是 MySQL JSON，写入需显式序列化并做类型转换 */
  jsonb?: readonly string[];
  /** 导出顺序键：按主键排序，保证多次执行结果可复现 */
  orderBy: string;
}

/** 按外键依赖排序：父表先写，子表的引用才不落空（顺序同 ADR B5 第 1 条） */
const TABLES: readonly TableSpec[] = [
  {
    name: 'users',
    columns: ['id', 'username', 'password', 'role', 'status', 'created_at'],
    identity: 'id',
    orderBy: 'id',
  },
  {
    name: 'user_sessions',
    columns: ['token', 'user_id', 'created_at', 'expires_at'],
    orderBy: 'token',
  },
  {
    name: 'conversations',
    columns: ['id', 'user_id', 'title', 'summary', 'summary_upto_seq', 'created_at', 'updated_at'],
    orderBy: 'id',
  },
  {
    name: 'messages',
    columns: [
      'seq',
      'id',
      'conversation_id',
      'role',
      'content',
      'tools',
      'attachments',
      'sources',
      'created_at',
    ],
    identity: 'seq',
    jsonb: ['tools', 'attachments', 'sources'],
    orderBy: 'seq',
  },
  {
    name: 'files',
    columns: ['id', 'user_id', 'name', 'ext', 'mime', 'size', 'created_at'],
    orderBy: 'id',
  },
  {
    name: 'api_logs',
    columns: [
      'id',
      'request_id',
      'method',
      'path',
      'status',
      'duration_ms',
      'user_id',
      'query_params',
      'request_body',
      'response_body',
      'error',
      'created_at',
    ],
    identity: 'id',
    orderBy: 'id',
  },
  {
    name: 'audit_logs',
    columns: ['id', 'actor_id', 'method', 'path', 'status', 'detail', 'created_at'],
    identity: 'id',
    orderBy: 'id',
  },
];

/** 清空语句里的表清单：外键相互引用的表必须在同一条 TRUNCATE 内，否则 PG 直接拒绝 */
const TRUNCATE_TABLES = TABLES.map((spec) => `"${spec.name}"`).join(', ');

/** 源库连接参数：仅本脚本使用，故不复用 AppConfig——MySQL 配置已随阶段 2 删除 */
function readMysqlConfig(): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** 与迁移前应用侧的 timezone: 'local' 对齐，让 DATETIME 解析出的 Date 与库内语义一致 */
  timezone: 'local';
} {
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'agent_data',
    timezone: 'local',
  };
}

/** 读源表：逐列显式列出（不用 SELECT *），按主键排序使结果可复现 */
async function readTable(mysql: MysqlPool, spec: TableSpec): Promise<Record<string, unknown>[]> {
  const [rows] = await mysql.query(
    `SELECT ${spec.columns.join(', ')} FROM \`${spec.name}\` ORDER BY ${spec.orderBy}`,
  );
  return rows as unknown as Record<string, unknown>[];
}

/**
 * 拼插入语句：PG 不支持 MySQL 的「多行 VALUES 嵌套数组展开」，改成逐行逐列展开 `$n`；
 * jsonb 列顺带补上 `::jsonb` 转换，让文本参数也落到正确类型。
 */
function insertSql(spec: TableSpec, rowCount: number): string {
  const width = spec.columns.length;
  const tuples = Array.from(
    { length: rowCount },
    (_, row) =>
      `(${spec.columns
        .map((column, col) => {
          const index = row * width + col + 1;
          return spec.jsonb?.includes(column) ? `$${index}::jsonb` : `$${index}`;
        })
        .join(', ')})`,
  );
  // IDENTITY 列按原值写入：不加 OVERRIDING SYSTEM VALUE 会被 PG 拒绝
  const override = spec.identity ? ' OVERRIDING SYSTEM VALUE' : '';
  return `INSERT INTO "${spec.name}" (${spec.columns.join(', ')})${override} VALUES ${tuples.join(', ')}`;
}

/** 行转参数：JSON 列显式序列化——驱动可能已解析成对象，也可能原样给回 JSON 文本 */
function toRowParams(spec: TableSpec, row: Record<string, unknown>): unknown[] {
  return spec.columns.map((column) => {
    const value = row[column] ?? null;
    if (value !== null && spec.jsonb?.includes(column) && typeof value !== 'string') {
      return JSON.stringify(value);
    }
    return value;
  });
}

/** 分批写入：单语句参数数有上限，按行切批，逐批一次往返 */
async function insertBatched(
  client: PoolClient,
  spec: TableSpec,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += BATCH_ROWS) {
    const batch = rows.slice(start, start + BATCH_ROWS);
    await client.query(
      insertSql(spec, batch.length),
      batch.flatMap((row) => toRowParams(spec, row)),
    );
  }
}

/**
 * 对齐 IDENTITY 序列：显式带原值写入后序列仍停在起点，不 setval 则下一次插入会撞主键。
 * 序列名经 pg_get_serial_sequence 按「表 + 列」反查，免去手拼命名规则。
 */
async function alignSequence(client: PoolClient, spec: TableSpec): Promise<void> {
  if (!spec.identity) return;
  await client.query(
    `SELECT setval(pg_get_serial_sequence($1, $2),
                   COALESCE((SELECT MAX("${spec.identity}") FROM "${spec.name}"), 0) + 1, false)`,
    [spec.name, spec.identity],
  );
}

/** 取计数：COUNT(*) 是 int8，pg 默认按字符串返回，这里统一收敛成数字 */
async function countPg(client: PoolClient, sql: string): Promise<number> {
  const { rows } = await client.query(sql);
  const row = rows[0] as { count?: string | number } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * 搬运后校验（ADR B5 第 4 条）：逐表行数、`messages` 的 seq 集合一致性，
 * 以及「会话的 updated_at 不早于其最后一条消息」这条时间一致性。
 * 三者都在提交前跑，不达标即整批回滚，不留半套数据。
 */
async function verify(
  client: PoolClient,
  source: Map<string, number>,
  sourceSeqs: Set<number>,
): Promise<void> {
  for (const spec of TABLES) {
    const expected = source.get(spec.name) ?? 0;
    const actual = await countPg(client, `SELECT COUNT(*) AS count FROM "${spec.name}"`);
    if (actual !== expected) {
      throw new Error(`行数不一致：${spec.name} 源库 ${expected} 行，目标库 ${actual} 行`);
    }
  }

  // seq 按原值搬运，逐值比对源库集合：少了值说明有行漏搬，多了值说明被改写。
  // 不拿「MAX - MIN + 1 = COUNT」判连续——seq 由 AUTO_INCREMENT 分配，历史删除会在源库里留下空洞
  const seqs = [...sourceSeqs];
  if (seqs.length > 0) {
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS count FROM messages WHERE seq = ANY($1::bigint[])',
      [seqs],
    );
    const matched = Number((rows[0] as { count?: number })?.count ?? 0);
    if (matched !== seqs.length) {
      throw new Error(`messages 的 seq 不齐：源库 ${seqs.length} 个，目标库命中 ${matched} 个`);
    }
  }

  // 每次追加消息都会刷新所属会话的 updated_at：早于其最后一条消息即说明消息或时间被改写
  const inconsistent = await countPg(
    client,
    `SELECT COUNT(*) AS count FROM conversations c
      WHERE c.updated_at < (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id)`,
  );
  if (inconsistent > 0) {
    throw new Error(`有 ${inconsistent} 个会话的 updated_at 早于其最后一条消息`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const mysql = createPool(readMysqlConfig());
  const pool = createPgPool(config.postgres);
  const client = await pool.connect();
  const counts = new Map<string, number>();
  const messageSeqs = new Set<number>();
  try {
    await client.query('BEGIN');
    try {
      // 不做双写：每次以源库为准整体覆盖；重启序列后再显式带原值写回，最后由 setval 对齐
      await client.query(`TRUNCATE ${TRUNCATE_TABLES} RESTART IDENTITY`);
      for (const spec of TABLES) {
        const rows = await readTable(mysql, spec);
        // 逐条记下源库 seq 供校验比对：行数相同不代表「每条都对得上」
        if (spec.name === 'messages') {
          for (const row of rows) messageSeqs.add(Number(row.seq));
        }
        await insertBatched(client, spec, rows);
        counts.set(spec.name, rows.length);
      }
      for (const spec of TABLES) await alignSequence(client, spec);
      await verify(client, counts, messageSeqs);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    const summary = TABLES.map((spec) => `${spec.name} ${counts.get(spec.name) ?? 0}`).join(' / ');
    console.log(`关系库搬迁完成：${summary}`);
  } finally {
    client.release();
    await pool.end();
    await mysql.end();
  }
}

main().catch((error: unknown) => {
  console.error('关系库搬迁失败', error);
  process.exitCode = 1;
});
