import type { KnowledgeStoreOptions, KnowledgeVectorStore, StoredChunkHit } from './vectorStore.js';
import type { Pool, PoolClient } from 'pg';
import {
  CHUNK_COLUMNS,
  CHUNKS_TABLE,
  COUNT_CHUNKS_SQL,
  COUNT_DOCUMENTS_SQL,
  CREATE_CHUNK_INDEXES_SQL,
  createChunksSql,
  createDocumentsSql,
  DOCUMENT_COLUMNS,
  DOCUMENTS_TABLE,
  ensureVectorIndex,
  FIND_DOCUMENT_SQL,
  insertRowsSql,
  LIST_ALL_DOCUMENTS_SQL,
  LIST_DOCUMENTS_SQL,
  normalizeRow,
  READ_BASELINE_SQL,
  SEARCH_CHUNKS_SQL,
  SESSION_PARAMETERS,
  STITCH_CHUNKS_SQL,
  toChunkParams,
  toDocumentParams,
  toVectorParam,
} from './pg.js';

/** 未建表时按「无数据」返回：读取路径不该因「还没入过库」报错，与 LanceDB 适配器同口径。只吞 undefined_table */
async function emptyWhenMissing<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return fallback;
    throw error;
  }
}

/**
 * 知识库向量存储的 pgvector 适配器（见 docs/adr/0012 · 阶段 1）。
 * 连接池由组合根建好后注入：池归本适配器独用，close() 连同池一并关闭；
 * 会话级检索参数在每条连接首次取用时装载，保证「参数就位之后才发检索语句」——
 * pg 的连接池不重置会话态，故每条连接只需装载一次。
 * LanceDB 适配器（rag/lanceStore.ts）作为回退路径保留一个迭代周期。
 */
export class PgVectorStore implements KnowledgeVectorStore {
  /** 向量基准：首次校验后缓存，用于发现维度或模型变化 */
  private baseline?: { dim: number; model: string };
  /** 已装载会话参数的连接：出池复用的连接不重置会话态，按对象身份记账即可 */
  private readonly prepared = new WeakSet<PoolClient>();

  constructor(
    private readonly pool: Pool,
    private readonly options: KnowledgeStoreOptions,
  ) {}

  /** 取一条连接并保证会话参数就位；任务抛错也照常归还连接，不留占位 */
  private async run<T>(task: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      if (!this.prepared.has(client)) {
        await client.query(SESSION_PARAMETERS);
        this.prepared.add(client);
      }
      return await task(client);
    } finally {
      client.release();
    }
  }

  async ensureDocumentStore(): Promise<void> {
    await this.run((client) => client.query(createDocumentsSql()));
  }

  async ensureChunkStore(dim: number): Promise<void> {
    await this.run(async (client) => {
      await client.query(createChunksSql(dim));
      await client.query(CREATE_CHUNK_INDEXES_SQL);
      await ensureVectorIndex(client);
    });
  }

  async addDocument(row: Record<string, unknown>): Promise<void> {
    await this.run((client) =>
      client.query(insertRowsSql(DOCUMENTS_TABLE, DOCUMENT_COLUMNS, 1), toDocumentParams(row)),
    );
  }

  async addChunks(rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    await this.run((client) => this.insertChunks(client, rows));
  }

  /** 批量写片段：分片序号取数组次序；空数组直接跳过（拼不出合法的 VALUES 子句） */
  private async insertChunks(client: PoolClient, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    await client.query(
      insertRowsSql(CHUNKS_TABLE, CHUNK_COLUMNS, rows.length),
      rows.flatMap((row, index) => toChunkParams(row, index)),
    );
  }

  /**
   * 原位重建：先删文档行（片段由外键级联删掉），再写新文档行、最后写新片段。
   * 顺序由外键决定——片段行引用文档行，必须先有父行；三步同事务，中途失败不留半套数据
   */
  async replaceDocument(
    id: string,
    document: Record<string, unknown>,
    chunks: Record<string, unknown>[],
  ): Promise<void> {
    await this.run(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`DELETE FROM ${DOCUMENTS_TABLE} WHERE id = $1`, [id]);
        await client.query(
          insertRowsSql(DOCUMENTS_TABLE, DOCUMENT_COLUMNS, 1),
          toDocumentParams(document),
        );
        await this.insertChunks(client, chunks);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  /** 删除文档：片段随外键 ON DELETE CASCADE 一并消失，不需要第二条 DELETE */
  async removeDocument(id: string): Promise<void> {
    await this.run((client) => client.query(`DELETE FROM ${DOCUMENTS_TABLE} WHERE id = $1`, [id]));
  }

  async findDocument(id: string): Promise<Record<string, unknown> | null> {
    return emptyWhenMissing(async () => {
      const { rows } = await this.run((client) => client.query(FIND_DOCUMENT_SQL, [id]));
      const row = rows[0] as Record<string, unknown> | undefined;
      return row ? normalizeRow(row) : null;
    }, null);
  }

  async listDocuments(userId: number): Promise<Record<string, unknown>[]> {
    return emptyWhenMissing(async () => {
      const { rows } = await this.run((client) => client.query(LIST_DOCUMENTS_SQL, [userId]));
      return rows.map((row: Record<string, unknown>) => normalizeRow(row));
    }, []);
  }

  async listAllDocuments(): Promise<Record<string, unknown>[]> {
    return emptyWhenMissing(async () => {
      const { rows } = await this.run((client) => client.query(LIST_ALL_DOCUMENTS_SQL));
      return rows.map((row: Record<string, unknown>) => normalizeRow(row));
    }, []);
  }

  async countDocuments(): Promise<number> {
    return emptyWhenMissing(() => this.count(COUNT_DOCUMENTS_SQL), 0);
  }

  async countChunks(): Promise<number> {
    return emptyWhenMissing(() => this.count(COUNT_CHUNKS_SQL), 0);
  }

  /** COUNT(*) 是 int8，pg 默认按字符串返回，这里当场收敛成数字 */
  private async count(sql: string): Promise<number> {
    const { rows } = await this.run((client) => client.query<{ count: string }>(sql));
    return Number(rows[0]?.count ?? 0);
  }

  /** 旧文档按分片序号拼正文：chunk_index 记录了分片原始次序 */
  async stitchChunks(documentId: string): Promise<string> {
    return emptyWhenMissing(async () => {
      const { rows } = await this.run((client) =>
        client.query<{ content: string }>(STITCH_CHUNKS_SQL, [documentId]),
      );
      return rows.map((row) => row.content).join('\n\n');
    }, '');
  }

  async searchChunks(
    vector: number[],
    options: { userId: number; topK: number },
  ): Promise<StoredChunkHit[]> {
    return emptyWhenMissing(async () => {
      const { rows } = await this.run((client) =>
        client.query<{
          document_id: string;
          title: string;
          content: string;
          score: number;
        }>(SEARCH_CHUNKS_SQL, [toVectorParam(vector), options.userId, options.topK]),
      );
      // 阈值过滤留在检索层，与现状「先按 topK 取回再按 minScore 过滤」一致
      return rows.map((row) => ({
        documentId: row.document_id,
        title: row.title,
        content: row.content,
        score: Number(row.score),
      }));
    }, []);
  }

  /** 读取库内已登记的向量基准；空库或未建表时以当前配置作为基准 */
  private async readBaseline(): Promise<{ dim: number; model: string }> {
    if (this.baseline) return this.baseline;
    const rows = await emptyWhenMissing<Array<{ dim: number; embedding_model: string }>>(
      async () => (await this.run((client) => client.query(READ_BASELINE_SQL))).rows,
      [],
    );
    const row = rows[0];
    this.baseline = row
      ? { dim: Number(row.dim), model: row.embedding_model }
      : { dim: 0, model: this.options.embeddingModel };
    return this.baseline;
  }

  /**
   * 校验向量维度与模型：换模型后新旧向量不具备可比性，
   * 必须显式报错，否则会按前若干维截断算出错误相似度
   */
  async assertCompatible(dim: number): Promise<void> {
    const baseline = await this.readBaseline();
    if (baseline.model !== this.options.embeddingModel) {
      throw new Error(
        `知识库由 ${baseline.model} 建立，当前向量模型为 ${this.options.embeddingModel}，请清空知识库后重新导入`,
      );
    }
    if (baseline.dim !== 0 && baseline.dim !== dim) {
      throw new Error(`向量维度不一致：知识库为 ${baseline.dim} 维，当前为 ${dim} 维`);
    }
    this.baseline = { dim, model: this.options.embeddingModel };
  }

  /** 关闭连接池：池归向量库独用，停机时随知识库一并释放 */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
