import type { ClientRunner } from './queries.js';
import type { KnowledgeStoreOptions, KnowledgeVectorStore, StoredChunkHit } from './vectorStore.js';
import type { DocumentStatus } from '../../entities/knowledge.js';
import type { Pool, PoolClient } from 'pg';
import { CHUNKS_TABLE, DOCUMENTS_TABLE, SESSION_PARAMETERS, insertRowsSql } from './pg.js';
import {
  ADD_CHUNK_COLUMNS_SQL,
  CHUNK_COLUMNS,
  CREATE_CHUNK_INDEXES_SQL,
  createChunksSql,
  ensureVectorIndex,
  toChunkParams,
} from './pgChunks.js';
import {
  ADD_DOCUMENT_COLUMNS_SQL,
  DOCUMENT_COLUMNS,
  READ_BASELINE_SQL,
  SET_DOCUMENT_STATUS_SQL,
  createDocumentsSql,
  toDocumentParams,
  toDocumentUpdateParams,
  UPDATE_DOCUMENT_CONTENT_SQL,
} from './pgDocuments.js';
import {
  emptyWhenMissing,
  readAllDocuments,
  readBaseDocuments,
  readChunkCount,
  readDocument,
  readDocumentCount,
  readStitchedContent,
  searchChunkHits,
} from './queries.js';

/**
 * 知识库向量存储的 PostgreSQL + pgvector 适配器（见 docs/adr/0012）。
 * 连接池由组合根建好后注入：池归本适配器独用，close() 连同池一并关闭；
 * 会话级检索参数在每条连接首次取用时装载，保证「参数就位之后才发检索语句」——
 * pg 的连接池不重置会话态，故每条连接只需装载一次。
 * 读路径 SQL 与结果映射外提在 queries.ts，这里只做转发。
 */
export class PgVectorStore implements KnowledgeVectorStore {
  /** 向量基准：首次校验后缓存，用于发现维度或模型变化 */
  private baseline?: { dim: number; model: string };
  /** 已装载会话参数的连接：出池复用的连接不重置会话态，按对象身份记账即可 */
  private readonly prepared = new WeakSet<PoolClient>();
  /** 读路径自由函数所需的连接租用器：把私有的 run 收成稳定引用传出去 */
  private readonly runBound: ClientRunner = (task) => this.run(task);

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
    await this.run(async (client) => {
      await client.query(createDocumentsSql());
      // 存量表不会因 CREATE IF NOT EXISTS 长出新列，每次初始化都幂等补列与约束
      await client.query(ADD_DOCUMENT_COLUMNS_SQL);
      // 片段表也要在启动时补列：检索路径只读不写，等到第一次写入才补会让升级后的首次检索报错。
      // 首次启动时片段表尚未建（需向量维度），ALTER TABLE IF EXISTS 会跳过
      await client.query(ADD_CHUNK_COLUMNS_SQL);
    });
  }

  async ensureChunkStore(dim: number): Promise<void> {
    await this.run(async (client) => {
      await client.query(createChunksSql(dim));
      // 存量片段表补列：与文档表同理，建表语句不会给已有表加 page 列
      await client.query(ADD_CHUNK_COLUMNS_SQL);
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

  async setDocumentStatus(
    id: string,
    status: DocumentStatus,
    failureReason: string | null,
  ): Promise<boolean> {
    return this.run(async (client) => {
      const result = await client.query(SET_DOCUMENT_STATUS_SQL, [id, status, failureReason]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async writeDocumentContent(
    id: string,
    document: Record<string, unknown>,
    chunks: Record<string, unknown>[],
  ): Promise<boolean> {
    return this.run(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await client.query(
          UPDATE_DOCUMENT_CONTENT_SQL,
          toDocumentUpdateParams({ ...document, id }),
        );
        // 文档在解析期间被删：整个事务回滚，片段也不能落地，否则外键找不到父行
        if ((result.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query(`DELETE FROM ${CHUNKS_TABLE} WHERE document_id = $1`, [id]);
        await this.insertChunks(client, chunks);
        await client.query('COMMIT');
        return true;
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

  findDocument(id: string): Promise<Record<string, unknown> | null> {
    return readDocument(this.runBound, id);
  }

  listDocuments(baseId: string): Promise<Record<string, unknown>[]> {
    return readBaseDocuments(this.runBound, baseId);
  }

  listAllDocuments(): Promise<Record<string, unknown>[]> {
    return readAllDocuments(this.runBound);
  }

  countDocuments(): Promise<number> {
    return readDocumentCount(this.runBound);
  }

  countChunks(): Promise<number> {
    return readChunkCount(this.runBound);
  }

  stitchChunks(documentId: string): Promise<string> {
    return readStitchedContent(this.runBound, documentId);
  }

  searchChunks(
    vector: number[],
    options: { baseIds: string[]; topK: number },
  ): Promise<StoredChunkHit[]> {
    return searchChunkHits(this.runBound, vector, options);
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

  /** 关闭连接池：池归向量库独用，停机时随知识库一并关闭 */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
