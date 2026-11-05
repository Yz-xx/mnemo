import type { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  migrateKnowledgeBases,
  SHARED_KNOWLEDGE_BASE_ID,
} from '../../infrastructure/db/schema/knowledgeBases.js';

/** 记录一次查询：SQL 与绑定参数 */
interface QueryCall {
  sql: string;
  values: unknown[];
}

/**
 * 替身迁移连接：记录查询并按「SQL 片段 → 结果」脚本依次消费作答
 * （与 pgStore.test.ts / bases.test.ts 同族模式，Client 形状只需 query）。
 */
function createFakeClient(script: Array<[string, unknown[] | Error]>): {
  calls: QueryCall[];
  client: Client;
} {
  const pending = script.map(([match, rows]) => ({ match, rows, used: false }));
  const calls: QueryCall[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      const entry = pending.find((item) => !item.used && sql.includes(item.match));
      const outcome = entry ? ((entry.used = true), entry.rows) : [];
      if (outcome instanceof Error) throw outcome;
      return { rows: outcome as Record<string, unknown>[], rowCount: outcome.length };
    },
  } as unknown as Client;
  return { calls, client };
}

describe('migrateKnowledgeBases', () => {
  it('新装库直通：旧列与旧索引都不存在时只补 conversations 列，不建共享库不删列', async () => {
    const { calls, client } = createFakeClient([
      // 守卫探测：旧列与旧索引均已清空（新装库 / 已迁移完的库都走这条）
      ['AS pending', [{ pending: false }]],
    ]);

    await migrateKnowledgeBases(client);

    // 补列无条件幂等执行，但搬运与删列一步都不发生
    expect(calls.some((call) => call.sql.includes('ALTER TABLE conversations'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('ON CONFLICT (id) DO NOTHING'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('DROP COLUMN'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('UPDATE knowledge_documents'))).toBe(false);
  });

  it('完整迁移：按 owner 建库搬运私有文档，global 文档入共享库，片段回填后补外键并删冗余列', async () => {
    const { calls, client } = createFakeClient([
      // 守卫：仍有旧列
      ['AS pending', [{ pending: true }]],
      // documents / chunks 各补一列
      ['ADD COLUMN IF NOT EXISTS knowledge_base_id', []],
      ['ADD COLUMN IF NOT EXISTS knowledge_base_id', []],
      // 共享库：固定 UUID 幂等插入
      ['ON CONFLICT (id) DO NOTHING', []],
      // 按可见性搬运前先确认旧 scope 列还在
      ['table_name = $1', [{ column_name: 'scope' }]],
      // 待迁 owner 清单
      ['DISTINCT owner_user_id', [{ owner_user_id: 7 }]],
      // owner 事务：查已有库（无）→ 建「我的知识库」→ 搬运
      ['BEGIN', []],
      ["visibility = 'private' AND owner_user_id", []],
      ['VALUES ($1, $2, NULL, $3, $4, $5, $5)', []],
      ["scope = 'private'", []],
      ['COMMIT', []],
      // global 文档搬运
      ["scope = 'global'", []],
      // 片段回填
      ['UPDATE knowledge_chunks', []],
      // 复核（documents / chunks）
      ['FROM knowledge_documents', [{ unassigned: 0 }]],
      ['FROM knowledge_chunks', [{ unassigned: 0 }]],
      // 补外键
      ['FOREIGN KEY', []],
      // SET NOT NULL（documents / chunks）
      ['SET NOT NULL', []],
      ['SET NOT NULL', []],
      // 删冗余列与旧索引、建新索引（DROP COLUMN ×4 → DROP INDEX → CREATE INDEX）
      ['DROP COLUMN', []],
      ['DROP COLUMN', []],
      ['DROP COLUMN', []],
      ['DROP COLUMN', []],
      ['DROP INDEX IF EXISTS idx_chunks_visibility', []],
      ['CREATE INDEX IF NOT EXISTS idx_chunks_base', []],
    ]);

    await migrateKnowledgeBases(client);

    // 共享库插入带固定 UUID
    const shared = calls.find((call) => call.sql.includes('ON CONFLICT (id) DO NOTHING'));
    expect(shared?.values).toContain(SHARED_KNOWLEDGE_BASE_ID);
    // owner 搬运在事务内成对提交，不可中途半套
    const sqls = calls.map((call) => call.sql);
    expect(sqls.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
    expect(sqls.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(sqls.indexOf('BEGIN')).toBeLessThan(sqls.indexOf('COMMIT'));
    // 存量表补外键：删库才能级联删文档
    expect(sqls.some((sql) => sql.includes('FOREIGN KEY'))).toBe(true);
    // 片段表冗余可见性列被删除
    expect(sqls.filter((sql) => sql.includes('DROP COLUMN'))).toHaveLength(4);
  });

  it('复核仍有未归属文档时抛错不删列：中断场景留待下次启动自愈', async () => {
    const { calls, client } = createFakeClient([
      ['AS pending', [{ pending: true }]],
      ['ADD COLUMN IF NOT EXISTS knowledge_base_id', []],
      ['ADD COLUMN IF NOT EXISTS knowledge_base_id', []],
      ['ON CONFLICT (id) DO NOTHING', []],
      ['table_name = $1', [{ column_name: 'scope' }]],
      ['DISTINCT owner_user_id', []],
      ["scope = 'global'", []],
      ['UPDATE knowledge_chunks', []],
      // 复核发现 documents 仍有未归属行
      ['FROM knowledge_documents', [{ unassigned: 2 }]],
    ]);

    await expect(migrateKnowledgeBases(client)).rejects.toThrow();
    expect(calls.some((call) => call.sql.includes('DROP COLUMN'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('SET NOT NULL'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('FOREIGN KEY'))).toBe(false);
  });

  it('中断自愈：owner 清单只取仍有未归属文档的用户', async () => {
    const { calls, client } = createFakeClient([
      ['AS pending', [{ pending: true }]],
      ['ADD COLUMN IF NOT EXISTS knowledge_base_id', []],
      ['ADD COLUMN IF NOT EXISTS knowledge_base_id', []],
      ['ON CONFLICT (id) DO NOTHING', []],
      ['table_name = $1', [{ column_name: 'scope' }]],
      ['DISTINCT owner_user_id', [{ owner_user_id: 9 }]],
      ['BEGIN', []],
      // 中断后自愈：该 owner 已有兜底库（上次建好但 UPDATE 没跑），复用不重建
      ["visibility = 'private' AND owner_user_id", [{ id: 'kb-existing' }]],
      ["scope = 'private'", []],
      ['COMMIT', []],
      ["scope = 'global'", []],
      ['UPDATE knowledge_chunks', []],
      ['FROM knowledge_documents', [{ unassigned: 0 }]],
      ['FROM knowledge_chunks', [{ unassigned: 0 }]],
      ['FOREIGN KEY', []],
      ['SET NOT NULL', []],
      ['SET NOT NULL', []],
      ['DROP COLUMN', []],
      ['DROP COLUMN', []],
      ['DROP COLUMN', []],
      ['DROP COLUMN', []],
      ['DROP INDEX IF EXISTS idx_chunks_visibility', []],
      ['CREATE INDEX IF NOT EXISTS idx_chunks_base', []],
    ]);

    await migrateKnowledgeBases(client);

    // 复用既有库：owner 事务内不再 INSERT 新库
    const ownerInserts = calls.filter(
      (call) =>
        call.sql.includes('INSERT INTO knowledge_bases') && !call.sql.includes('ON CONFLICT'),
    );
    expect(ownerInserts).toHaveLength(0);
    // 搬运 UPDATE 复用查到的库 id（须排除同样含 scope = 'private' 的 owner 清单查询）
    const ownerMove = calls.find(
      (call) =>
        call.sql.includes('UPDATE knowledge_documents') && call.sql.includes("scope = 'private'"),
    );
    expect(ownerMove?.values).toContain('kb-existing');
  });

  it('删列阶段中断：documents 旧列已删但 chunks 仍有旧列时继续收尾，不重复搬运', async () => {
    const { calls, client } = createFakeClient([
      // 守卫：documents 侧清空但 chunks 侧残留
      ['AS pending', [{ pending: true }]],
      ['ADD COLUMN IF NOT EXISTS knowledge_base_id', []],
      ['ADD COLUMN IF NOT EXISTS knowledge_base_id', []],
      ['ON CONFLICT (id) DO NOTHING', []],
      // documents.scope 已不存在：跳过 owner / global 搬运
      ['table_name = $1', []],
      ['UPDATE knowledge_chunks', []],
      ['FROM knowledge_documents', [{ unassigned: 0 }]],
      ['FROM knowledge_chunks', [{ unassigned: 0 }]],
      ['FOREIGN KEY', []],
      ['SET NOT NULL', []],
      ['SET NOT NULL', []],
      ['DROP COLUMN', []],
      ['DROP COLUMN', []],
      ['DROP COLUMN', []],
      ['DROP COLUMN', []],
      ['DROP INDEX IF EXISTS idx_chunks_visibility', []],
      ['CREATE INDEX IF NOT EXISTS idx_chunks_base', []],
    ]);

    await migrateKnowledgeBases(client);

    // 不重复搬运、但 chunks 的旧列与旧索引必须清完
    expect(calls.some((call) => call.sql.includes('DISTINCT owner_user_id'))).toBe(false);
    expect(calls.some((call) => call.sql.includes("scope = 'global'"))).toBe(false);
    expect(calls.filter((call) => call.sql.includes('DROP COLUMN'))).toHaveLength(4);
    expect(
      calls.some((call) => call.sql.includes('DROP INDEX IF EXISTS idx_chunks_visibility')),
    ).toBe(true);
  });
});
