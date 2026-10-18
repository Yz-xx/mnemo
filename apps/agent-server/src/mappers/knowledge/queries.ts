import type { StoredChunkHit } from './vectorStore.js';
import type { PoolClient } from 'pg';
import {
  COUNT_CHUNKS_SQL,
  COUNT_DOCUMENTS_SQL,
  FIND_DOCUMENT_SQL,
  LIST_ALL_DOCUMENTS_SQL,
  LIST_DOCUMENTS_SQL,
  normalizeRow,
  SEARCH_CHUNKS_SQL,
  STITCH_CHUNKS_SQL,
  toVectorParam,
} from './pg.js';

/** 连接租用器：取一条连接、保证会话参数就位后在其上执行任务（实现见 pgStore 的 run） */
export type ClientRunner = <T>(task: (client: PoolClient) => Promise<T>) => Promise<T>;

/** 未建表时按「无数据」返回：读取路径不该因「还没入过库」报错。只吞 undefined_table */
export async function emptyWhenMissing<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return fallback;
    throw error;
  }
}

/** COUNT(*) 是 int8，pg 默认按字符串返回，这里当场收敛成数字 */
async function count(run: ClientRunner, sql: string): Promise<number> {
  const { rows } = await run((client) => client.query<{ count: string }>(sql));
  return Number(rows[0]?.count ?? 0);
}

/** 按 id 取文档行，不存在返回 null */
export async function readDocument(
  run: ClientRunner,
  id: string,
): Promise<Record<string, unknown> | null> {
  return emptyWhenMissing(async () => {
    const { rows } = await run((client) => client.query(FIND_DOCUMENT_SQL, [id]));
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? normalizeRow(row) : null;
  }, null);
}

/** 取对指定用户可见的文档行：全局共享的 + 其本人的私有文档 */
export async function readUserDocuments(
  run: ClientRunner,
  userId: number,
): Promise<Record<string, unknown>[]> {
  return emptyWhenMissing(async () => {
    const { rows } = await run((client) => client.query(LIST_DOCUMENTS_SQL, [userId]));
    return rows.map((row: Record<string, unknown>) => normalizeRow(row));
  }, []);
}

/** 取全部文档行，不做可见性过滤（管理端用） */
export async function readAllDocuments(run: ClientRunner): Promise<Record<string, unknown>[]> {
  return emptyWhenMissing(async () => {
    const { rows } = await run((client) => client.query(LIST_ALL_DOCUMENTS_SQL));
    return rows.map((row: Record<string, unknown>) => normalizeRow(row));
  }, []);
}

/** 文档总数 */
export function readDocumentCount(run: ClientRunner): Promise<number> {
  return emptyWhenMissing(() => count(run, COUNT_DOCUMENTS_SQL), 0);
}

/** 片段总数：检索前判空用，空库可直接返回无命中，省一次向量化 */
export function readChunkCount(run: ClientRunner): Promise<number> {
  return emptyWhenMissing(() => count(run, COUNT_CHUNKS_SQL), 0);
}

/** 旧文档按分片序号拼正文：chunk_index 记录了分片原始次序 */
export async function readStitchedContent(run: ClientRunner, documentId: string): Promise<string> {
  return emptyWhenMissing(async () => {
    const { rows } = await run((client) =>
      client.query<{ content: string }>(STITCH_CHUNKS_SQL, [documentId]),
    );
    return rows.map((row) => row.content).join('\n\n');
  }, '');
}

/** 近邻检索：按可见性预过滤后取相似度前 topK 条，分数不做阈值过滤 */
export async function searchChunkHits(
  run: ClientRunner,
  vector: number[],
  options: { userId: number; topK: number },
): Promise<StoredChunkHit[]> {
  return emptyWhenMissing(async () => {
    const { rows } = await run((client) =>
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
