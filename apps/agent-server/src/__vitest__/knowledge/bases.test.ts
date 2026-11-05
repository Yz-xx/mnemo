import type { DbPool } from '../../infrastructure/db/pool.js';
import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { KnowledgeBaseStore } from '../../mappers/knowledge/bases.js';

/** 记录一次查询：SQL 文本与绑定参数 */
interface QueryCall {
  sql: string;
  params: unknown[];
}

/**
 * 替身连接池：记录查询并按「SQL 片段 → 结果」脚本**依次消费**作答。
 * 同一片段的多次调用按条目顺序各取一次（第一次命中第一条，第二次命中第二条），
 * 用于表达「第一次查到、第二次不存在」这类时序场景；脚本耗尽后未命中的语句返回空结果。
 * 本测试面不使用 connect，误用即报错，避免替身悄悄放行未约定的行为。
 */
function createFakePool(script: Array<[string, unknown[] | Error]>): {
  calls: QueryCall[];
  pool: DbPool;
} {
  const pending = script.map(([match, outcome]) => ({ match, outcome, used: false }));
  const calls: QueryCall[] = [];
  const pool = {
    async query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      const entry = pending.find((item) => !item.used && sql.includes(item.match));
      const outcome = entry ? ((entry.used = true), entry.outcome) : [];
      if (outcome instanceof Error) throw outcome;
      return { rows: outcome as R[], rowCount: (outcome as R[]).length };
    },
    async connect(): Promise<never> {
      throw new Error('知识库 mapper 测试不使用 connect');
    },
    async end(): Promise<void> {},
  } as unknown as DbPool;
  return { calls, pool };
}

describe('KnowledgeBaseStore', () => {
  it('新建私有库：INSERT 携带生成的 uuid 与时间，返回行映射实体', async () => {
    const row = {
      id: 'kb-1',
      name: '产品手册',
      description: null,
      visibility: 'private',
      owner_user_id: 7,
      created_at: '2026-11-05T08:00:00.000Z',
      updated_at: '2026-11-05T08:00:00.000Z',
    };
    const { calls, pool } = createFakePool([['INSERT INTO knowledge_bases', [row]]]);
    const store = new KnowledgeBaseStore(pool);

    const base = await store.create({ name: '产品手册', visibility: 'private', ownerUserId: 7 });

    expect(base).toEqual({
      id: 'kb-1',
      name: '产品手册',
      description: null,
      visibility: 'private',
      ownerUserId: 7,
      createdAt: '2026-11-05T08:00:00.000Z',
      updatedAt: '2026-11-05T08:00:00.000Z',
    });
    const call = calls.find((item) => item.sql.includes('INSERT INTO knowledge_bases'));
    expect(call?.params).toHaveLength(6);
    // 归属与可见性成对绑定：私有库必须带 owner，SQL 参数按此对齐
    expect(call?.params).toEqual(expect.arrayContaining(['产品手册', 'private', 7]));
  });

  it('新建共享库：owner 写 null，全局库无归属', async () => {
    const row = {
      id: 'kb-shared',
      name: '共享知识库',
      description: null,
      visibility: 'global',
      owner_user_id: null,
      created_at: '2026-11-05T08:00:00.000Z',
      updated_at: '2026-11-05T08:00:00.000Z',
    };
    const { calls, pool } = createFakePool([['INSERT INTO knowledge_bases', [row]]]);
    const store = new KnowledgeBaseStore(pool);

    const base = await store.create({
      name: '共享知识库',
      visibility: 'global',
      ownerUserId: null,
    });

    expect(base.ownerUserId).toBeNull();
    expect(base.visibility).toBe('global');
    expect(
      calls.find((item) => item.sql.includes('INSERT INTO knowledge_bases'))?.params,
    ).toContain(null);
  });

  it('列出可见库：全局与自有库都返回，文档计数按库分组补齐', async () => {
    const baseRows = [
      {
        id: 'kb-shared',
        name: '共享知识库',
        description: null,
        visibility: 'global',
        owner_user_id: null,
        created_at: '2026-11-05T08:00:00.000Z',
        updated_at: '2026-11-05T08:00:00.000Z',
      },
      {
        id: 'kb-mine',
        name: '我的知识库',
        description: null,
        visibility: 'private',
        owner_user_id: 7,
        created_at: '2026-11-05T09:00:00.000Z',
        updated_at: '2026-11-05T09:00:00.000Z',
      },
    ];
    const { calls, pool } = createFakePool([
      ['FROM knowledge_bases WHERE', baseRows],
      ['FROM knowledge_documents GROUP BY', [{ knowledge_base_id: 'kb-mine', count: '3' }]],
    ]);
    const store = new KnowledgeBaseStore(pool);

    const bases = await store.list(7);

    expect(bases).toHaveLength(2);
    expect(bases[0]).toMatchObject({ id: 'kb-shared', documentCount: 0 });
    expect(bases[1]).toMatchObject({ id: 'kb-mine', documentCount: 3 });
    // 列表按可见性过滤：全局或归属本人
    const listCall = calls.find((item) => item.sql.includes('FROM knowledge_bases WHERE'));
    expect(listCall?.params).toEqual([7]);
  });

  it('文档表尚未建（42P01）时列表照常返回，计数全部为 0', async () => {
    const baseRows = [
      {
        id: 'kb-mine',
        name: '我的知识库',
        description: null,
        visibility: 'private',
        owner_user_id: 7,
        created_at: '2026-11-05T09:00:00.000Z',
        updated_at: '2026-11-05T09:00:00.000Z',
      },
    ];
    const { pool } = createFakePool([
      ['FROM knowledge_bases WHERE', baseRows],
      [
        'FROM knowledge_documents GROUP BY',
        Object.assign(new Error('no table'), { code: '42P01' }),
      ],
    ]);
    const store = new KnowledgeBaseStore(pool);

    const bases = await store.list(7);

    expect(bases).toHaveLength(1);
    expect(bases[0]).toMatchObject({ id: 'kb-mine', documentCount: 0 });
  });

  it('按 id 查库：命中返回实体，非 UUID 或不存在一律返回 null', async () => {
    // find 的入参是 uuid 形状（实现里有 isUuid 守卫），测试数据因此取合法 UUID
    const uuid = '0c1d2e3f-4a5b-4c6d-8e9f-1a2b3c4d5e6f';
    const row = {
      id: uuid,
      name: '产品手册',
      description: '内部文档',
      visibility: 'private',
      owner_user_id: 7,
      created_at: '2026-11-05T08:00:00.000Z',
      updated_at: '2026-11-05T08:00:00.000Z',
    };
    const { calls, pool } = createFakePool([
      ['FROM knowledge_bases WHERE id', [row]],
      ['FROM knowledge_bases WHERE id', []],
    ]);
    const store = new KnowledgeBaseStore(pool);

    await expect(store.find(uuid)).resolves.toMatchObject({ id: uuid, description: '内部文档' });
    await expect(store.find('not-a-uuid')).resolves.toBeNull();
    await expect(store.find('kb-missing')).resolves.toBeNull();
    // 查询按 id 参数化，不拼接字符串
    expect(
      calls.filter((item) => item.sql.includes('FROM knowledge_bases WHERE id'))[0]?.params,
    ).toEqual([uuid]);
  });

  it('visibleIds：返回用户可见库的 id 清单，供检索过滤预解析', async () => {
    const { calls, pool } = createFakePool([
      ["visibility = 'global' OR owner_user_id", [{ id: 'kb-shared' }, { id: 'kb-mine' }]],
    ]);
    const store = new KnowledgeBaseStore(pool);

    const ids = await store.visibleIds(7);

    expect(ids).toEqual(['kb-shared', 'kb-mine']);
    expect(calls[0]?.params).toEqual([7]);
  });

  it('更新库：name 与 description 变更随 updated_at 一次往返，不存在返回 null', async () => {
    const row = {
      id: 'kb-1',
      name: '新名字',
      description: '新描述',
      visibility: 'private',
      owner_user_id: 7,
      created_at: '2026-11-05T08:00:00.000Z',
      updated_at: '2026-11-05T10:00:00.000Z',
    };
    const { pool } = createFakePool([
      ['UPDATE knowledge_bases', [row]],
      ['UPDATE knowledge_bases', []],
    ]);
    const store = new KnowledgeBaseStore(pool);

    const updated = await store.update('kb-1', { name: '新名字', description: '新描述' });
    expect(updated).toMatchObject({ name: '新名字', description: '新描述' });
    await expect(store.update('kb-missing', { name: 'x' })).resolves.toBeNull();
  });

  it('删除库：按 id 删除并返回是否删到行，文档与片段由外键级联承担', async () => {
    const { calls, pool } = createFakePool([['DELETE FROM knowledge_bases', [{ id: 'kb-1' }]]]);
    const store = new KnowledgeBaseStore(pool);

    await expect(store.remove('kb-1')).resolves.toBe(true);

    const call = calls.find((item) => item.sql.includes('DELETE FROM knowledge_bases'));
    expect(call?.params).toEqual(['kb-1']);
    expect(call?.sql).toContain('WHERE id = $1');
  });
});
