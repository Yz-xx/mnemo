import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { SESSION_PARAMETERS } from '../../mappers/knowledge/pg.js';
import { PgVectorStore } from '../../mappers/knowledge/pgStore.js';

const OPTIONS = {
  chunkSize: 60,
  chunkOverlap: 0,
  topK: 2,
  minScore: 0.6,
  embeddingModel: 'fake-embedding',
  embeddingEndpoint: 'http://127.0.0.1:11434',
};

interface QueryRecord {
  text: string;
  values: unknown[];
}

/** 表不存在的 PG 错误（SQLSTATE 42P01）：用于校验「读路径不因未建表报错」 */
function missingTable(): Error & { code: string } {
  return Object.assign(new Error('relation does not exist'), { code: '42P01' });
}

/** PostgreSQL 报错：按 SQLSTATE 决定是否可容错，故替身也要能按 SQLSTATE 抛错 */
function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg error ${code}`), { code });
}

type Respond = (sql: string) => unknown[] | Error;

/** 按「SQL 片段 → 结果」匹配作答：未命中的语句返回空结果集 */
function responder(map: Array<[string, unknown[] | Error]>): Respond {
  return (sql) => map.find(([match]) => sql.includes(match))?.[1] ?? [];
}

/** 替身连接：记录查询与参数，并按预设脚本作答 */
class FakeClient {
  readonly calls: QueryRecord[] = [];
  releases = 0;

  constructor(private readonly respond: Respond) {}

  async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.calls.push({ text: sql, values });
    const outcome = this.respond(sql);
    if (outcome instanceof Error) throw outcome;
    return { rows: outcome, rowCount: outcome.length };
  }

  release(): void {
    this.releases += 1;
  }
}

/** 替身连接池：同一条连接反复出借，用来观察会话参数的装载次数 */
class FakePool {
  readonly client: FakeClient;
  endCalls = 0;

  constructor(respond: Respond = () => []) {
    this.client = new FakeClient(respond);
  }

  connect(): Promise<PoolClient> {
    return Promise.resolve(this.client as unknown as PoolClient);
  }

  end(): Promise<void> {
    this.endCalls += 1;
    return Promise.resolve();
  }
}

/** 组装被测适配器：连接池为替身，隔离真实 PostgreSQL */
function createStore(respond?: Respond): { pool: FakePool; store: PgVectorStore } {
  const pool = new FakePool(respond);
  return { pool, store: new PgVectorStore(pool as unknown as Pool, OPTIONS) };
}

describe('PgVectorStore', () => {
  it('检索走可见性过滤并按序传参', async () => {
    const { pool, store } = createStore(
      responder([
        [
          'ORDER BY embedding',
          [{ document_id: 'doc-1', title: '水果手册', content: '苹果', score: '0.87' }],
        ],
      ]),
    );

    const hits = await store.searchChunks([1, 2, 3], { userId: 7, topK: 4 });

    expect(hits).toEqual([
      { documentId: 'doc-1', title: '水果手册', content: '苹果', score: 0.87 },
    ]);
    const search = pool.client.calls.find((call) => call.text.includes('ORDER BY embedding'));
    // 参数序：向量、用户 ID、条数；可见性谓词里用户 ID 退到 $2（向量占了 $1）
    expect(search?.values).toEqual(['[1,2,3]', 7, 4]);
    expect(search?.text).toContain("(scope = 'global' OR owner_user_id = $2)");
  });

  it('会话参数在每条连接上只装载一次', async () => {
    const { pool, store } = createStore();

    await store.searchChunks([1, 2, 3], { userId: 1, topK: 1 });
    await store.searchChunks([1, 2, 3], { userId: 1, topK: 1 });

    const prepared = pool.client.calls.filter((call) => call.text === SESSION_PARAMETERS);
    expect(prepared).toHaveLength(1);
  });

  it('未建表时读取路径按无数据返回，不抛错', async () => {
    const { store } = createStore(() => missingTable());

    await expect(store.listDocuments(1)).resolves.toEqual([]);
    await expect(store.listAllDocuments()).resolves.toEqual([]);
    await expect(store.findDocument('doc-1')).resolves.toBeNull();
    await expect(store.countDocuments()).resolves.toBe(0);
    await expect(store.countChunks()).resolves.toBe(0);
    await expect(store.stitchChunks('doc-1')).resolves.toBe('');
    await expect(store.searchChunks([1], { userId: 1, topK: 1 })).resolves.toEqual([]);
  });

  it('未建表以外的错误照常抛出', async () => {
    const { store } = createStore(() => pgError('08006'));

    await expect(store.listDocuments(1)).rejects.toThrow('pg error 08006');
  });

  it('COUNT 结果收敛成数字', async () => {
    const { store } = createStore(responder([['COUNT(*)', [{ count: '42' }]]]));

    await expect(store.countChunks()).resolves.toBe(42);
  });

  it('时间列读回 Date 时还原成 ISO 串', async () => {
    const { store } = createStore(
      responder([
        [
          'FROM knowledge_documents WHERE id',
          [
            {
              id: 'doc-1',
              created_at: new Date('2026-01-01T00:00:00.000Z'),
              updated_at: new Date('2026-01-02T00:00:00.000Z'),
            },
          ],
        ],
      ]),
    );

    const row = await store.findDocument('doc-1');

    expect(row).toEqual({
      id: 'doc-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });

  it('向量索引失效时先删后建，有效时不重建', async () => {
    const invalid = createStore(responder([['pg_class', [{ state: 'invalid' }]]]));
    await invalid.store.ensureChunkStore(3);
    const invalidSqls = invalid.pool.client.calls.map((call) => call.text);
    expect(invalidSqls.some((sql) => sql.startsWith('DROP INDEX CONCURRENTLY'))).toBe(true);
    expect(invalidSqls.some((sql) => sql.startsWith('CREATE INDEX CONCURRENTLY'))).toBe(true);

    const valid = createStore(responder([['pg_class', [{ state: 'valid' }]]]));
    await valid.store.ensureChunkStore(3);
    const validSqls = valid.pool.client.calls.map((call) => call.text);
    expect(validSqls.some((sql) => sql.startsWith('CREATE INDEX CONCURRENTLY'))).toBe(false);
  });

  it('原位重建按「删父行 → 写父行 → 写片段」同事务执行', async () => {
    const { pool, store } = createStore();

    await store.replaceDocument(
      'doc-1',
      {
        id: 'doc-1',
        title: '水果手册',
        scope: 'global',
        owner_user_id: null,
        chunks: 1,
        embedding_model: 'fake-embedding',
        dim: 2,
        created_at: '2026-01-01T00:00:00.000Z',
        content: '苹果',
        updated_at: null,
      },
      [
        {
          id: 'chunk-1',
          document_id: 'doc-1',
          title: '水果手册',
          content: '苹果',
          scope: 'global',
          owner_user_id: null,
          created_at: '2026-01-01T00:00:00.000Z',
          vector: [1, 2],
        },
      ],
    );

    // 顺序由外键决定：片段行引用文档行，必须先有父行；三步同事务，中途失败整批回滚
    const sqls = pool.client.calls.map((call) => call.text);
    expect(sqls[1]).toBe('BEGIN');
    expect(sqls[2]).toContain('DELETE FROM knowledge_documents');
    expect(sqls[3]).toContain('INSERT INTO knowledge_documents');
    expect(sqls[4]).toContain('INSERT INTO knowledge_chunks');
    expect(sqls[5]).toBe('COMMIT');
  });

  it('事务中途失败时回滚并抛出原错误', async () => {
    let attempted = 0;
    const { pool, store } = createStore((sql) => {
      if (sql.includes('INSERT INTO knowledge_documents')) {
        attempted += 1;
        return pgError('23505');
      }
      return [];
    });

    await expect(store.replaceDocument('doc-1', { id: 'doc-1' }, [])).rejects.toThrow(
      'pg error 23505',
    );

    const sqls = pool.client.calls.map((call) => call.text);
    expect(attempted).toBe(1);
    expect(sqls.at(-1)).toBe('ROLLBACK');
  });

  it('空片段批次不发插入语句（拼不出合法 VALUES）', async () => {
    const { pool, store } = createStore();

    await store.addChunks([]);

    expect(pool.client.calls).toHaveLength(0);
  });

  it('空库按当前配置通过基准校验', async () => {
    const { store } = createStore(responder([['knowledge_documents', []]]));

    await expect(store.assertCompatible(3)).resolves.toBeUndefined();
  });

  it('库内模型与当前配置不一致时明确报错', async () => {
    const { store } = createStore(
      responder([['knowledge_documents', [{ dim: 3, embedding_model: 'nomic-embed-text' }]]]),
    );

    await expect(store.assertCompatible(3)).rejects.toThrow('请清空知识库后重新导入');
  });

  it('close 连同连接池一并关闭', async () => {
    const { pool, store } = createStore();

    await store.close();

    expect(pool.endCalls).toBe(1);
  });
});
