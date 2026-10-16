/**
 * 知识库向量搬迁（见 docs/adr/0012 阶段 1 · 实施细则 A5）：
 * 把 LanceDB 里的存量文档与片段一次性导入 PostgreSQL + pgvector。
 *
 * 前置（三项）：
 *   1. PostgreSQL 已建库并执行过 CREATE EXTENSION vector（未启用扩展时建表会失败）
 *   2. 环境变量 PG_* 已配好：脚本经 --env-file 读 .env.development，可用系统环境变量覆盖
 *   3. 搬迁期间后端停止写入：本脚本先清空 PG 侧两张表再整批导入，不做双写（ADR 决策 8）
 *
 * 用法：pnpm --filter @repo/agent-server run migrate:vector
 * 幂等：可重复执行，每次以 LanceDB 当前内容为准覆盖 PG 侧数据；失败即整批回滚，不留半套
 */
import type { PoolClient } from 'pg';
import path from 'node:path';
import process from 'node:process';
import { connect } from '@lancedb/lancedb';
import { describeEmbeddingModel, loadConfig } from '../src/configuration/config/index.js';
import { createPgPool } from '../src/db/pool.js';
import {
  CHUNKS_TABLE as LANCE_CHUNKS_TABLE,
  DOCUMENTS_TABLE as LANCE_DOCUMENTS_TABLE,
} from '../src/rag/lance.js';
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
  insertRowsSql,
  toChunkParams,
  toDocumentParams,
} from '../src/rag/pg.js';

/** 单批行数：PG 单语句参数上限 65535，按列数折算后取远低于上限的保守值 */
const BATCH_ROWS = 1000;

/** LanceDB 库目录：与 LanceVectorStore 的定位口径保持一致 */
function lanceDir(dataDir: string): string {
  return path.join(dataDir, 'knowledge', 'lancedb');
}

/** 读 LanceDB 两张表：缺表一律按空表处理（知识库可能还没入过数据） */
async function readLanceStore(dataDir: string): Promise<{
  documents: Record<string, unknown>[];
  chunks: Record<string, unknown>[];
}> {
  const db = await connect(lanceDir(dataDir));
  const names = await db.tableNames();
  const readAll = async (name: string): Promise<Record<string, unknown>[]> => {
    if (!names.includes(name)) return [];
    const table = await db.openTable(name);
    const rows = await table.query().toArray();
    return rows as Record<string, unknown>[];
  };
  return {
    documents: await readAll(LANCE_DOCUMENTS_TABLE),
    chunks: await readAll(LANCE_CHUNKS_TABLE),
  };
}

/** 维度取自文档行登记的 dim；文档表为空时退回片段向量长度 */
function readDim(documents: Record<string, unknown>[], chunks: Record<string, unknown>[]): number {
  const declared = Number(documents[0]?.dim ?? 0);
  if (declared > 0) return declared;
  const vector = chunks[0]?.vector;
  return vector ? Array.from(vector as ArrayLike<number>).length : 0;
}

/**
 * 片段行 → 插入参数：chunk_index 取「同一文档内的出现序」。
 * LanceDB 侧靠物理写入序还原正文，PG 侧没有这个保证，必须显式记录序号，
 * 口径与 PgVectorStore 写入一致（见 rag/pg.ts 的 CREATE CHUNKS 说明）
 */
function toChunkParamList(chunks: Record<string, unknown>[]): unknown[][] {
  const counters = new Map<string, number>();
  return chunks.map((row) => {
    const documentId = String(row.document_id);
    const index = counters.get(documentId) ?? 0;
    counters.set(documentId, index + 1);
    return toChunkParams(row, index);
  });
}

/** 分批写入：单语句参数数受 PG 上限约束，按行切批，逐批一次往返 */
async function insertBatched(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  params: unknown[][],
): Promise<void> {
  for (let start = 0; start < params.length; start += BATCH_ROWS) {
    const batch = params.slice(start, start + BATCH_ROWS);
    await client.query(insertRowsSql(table, columns, batch.length), batch.flat());
  }
}

/**
 * 建表建索引与清空：全部在事务外执行
 * ——CREATE INDEX CONCURRENTLY 不允许出现在事务块里，一旦被 BEGIN 包住会直接报错。
 */
async function prepare(client: PoolClient, dim: number): Promise<void> {
  await client.query(createDocumentsSql());
  await client.query(createChunksSql(dim));
  await client.query(CREATE_CHUNK_INDEXES_SQL);
  await ensureVectorIndex(client);
  // 搬迁不做双写：每次以 LanceDB 当前内容为准整体覆盖
  await client.query(`TRUNCATE ${DOCUMENTS_TABLE}, ${CHUNKS_TABLE}`);
}

/** 单事务整批导入：文档行先写（片段行的外键要求父行已存在），中途失败整批回滚 */
async function importRows(
  client: PoolClient,
  documents: Record<string, unknown>[],
  chunks: Record<string, unknown>[],
): Promise<void> {
  await client.query('BEGIN');
  try {
    await insertBatched(client, DOCUMENTS_TABLE, DOCUMENT_COLUMNS, documents.map(toDocumentParams));
    await insertBatched(client, CHUNKS_TABLE, CHUNK_COLUMNS, toChunkParamList(chunks));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** 读表内行数：COUNT(*) 是 int8，pg 默认按字符串返回，此处收敛成数字 */
async function countRows(client: PoolClient, sql: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(sql);
  return Number(rows[0]?.count ?? 0);
}

/**
 * 搬迁后校验：行数与片段维度必须与源库一致，模型不一致直接失败。
 * 切换后服务会用当前配置的模型检索，旧向量与新模型不可比，宁可拦住交由人工确认
 */
async function verify(
  client: PoolClient,
  input: {
    documents: Record<string, unknown>[];
    chunks: Record<string, unknown>[];
    dim: number;
    model: string;
  },
): Promise<void> {
  const documentCount = await countRows(client, COUNT_DOCUMENTS_SQL);
  const chunkCount = await countRows(client, COUNT_CHUNKS_SQL);
  if (documentCount !== input.documents.length || chunkCount !== input.chunks.length) {
    throw new Error(
      `行数不一致：LanceDB 为 ${input.documents.length} 篇 / ${input.chunks.length} 条，PG 为 ${documentCount} 篇 / ${chunkCount} 条`,
    );
  }
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${CHUNKS_TABLE} WHERE vector_dims(embedding) <> $1`,
    [input.dim],
  );
  if (Number(rows[0]?.count ?? 0) > 0) {
    throw new Error(`片段向量维度与源库 ${input.dim} 维不一致`);
  }
  const stored = String(input.documents[0]?.embedding_model ?? '');
  if (stored && stored !== input.model) {
    throw new Error(
      `库内向量由 ${stored} 建立，当前配置为 ${input.model}，两者不可比，请换回原模型或清空后重导`,
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { documents, chunks } = await readLanceStore(config.dataDir);
  const dim = readDim(documents, chunks);
  if (dim <= 0) {
    console.log('LanceDB 中没有知识库数据，无需搬迁');
    return;
  }

  const pool = createPgPool(config.postgres);
  const client = await pool.connect();
  try {
    await prepare(client, dim);
    await importRows(client, documents, chunks);
    await verify(client, { documents, chunks, dim, model: describeEmbeddingModel(config) });
    console.log(
      `向量搬迁完成：文档 ${documents.length} 篇 / 片段 ${chunks.length} 条（${dim} 维）`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('向量搬迁失败', error);
  process.exitCode = 1;
});
