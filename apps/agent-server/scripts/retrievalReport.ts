/**
 * 检索验收报告（见 docs/adr/0012 阶段 4）：在真实语料上量化「召回条数 + HNSW 扫描量 + 检索延迟」，
 * 回答「迭代索引扫描在可见性过滤下是否会膨胀扫描量」这一头号不确定性。
 *
 * 口径说明：pgvector 不把「扫描了多少元组」暴露成计数器，只能借 `EXPLAIN (ANALYZE)` 取
 * 索引扫描节点的 `Actual Rows`（交给上层的候选行）与 `Rows Removed by Filter`（被可见性条件丢弃的行），
 * 两者之和即本次检索实际评估过的候选数——故本脚本是验收工具，不是线上埋点。
 *
 * 前置：PostgreSQL 已建表且有知识库数据；Ollama 向量服务可达（查询要真实向量化）。
 * 用法：pnpm --filter @repo/agent-server run report:retrieval
 * 可调：REPORT_QUERIES（逗号分隔，覆盖默认问题集）/ REPORT_USER_ID / REPORT_ROUNDS
 */
import type { PoolClient } from 'pg';
import process from 'node:process';
import {
  describeEmbeddingEndpoint,
  describeEmbeddingModel,
  loadConfig,
} from '../src/configuration/config/index.js';
import { createPgPool } from '../src/db/pool.js';
import { createEmbeddings } from '../src/llm/model.js';
import { SEARCH_CHUNKS_SQL, SESSION_PARAMETERS, toVectorParam } from '../src/rag/pg.js';
import { PgVectorStore } from '../src/rag/pgStore.js';

const ROUNDS = Number(process.env.REPORT_ROUNDS ?? 5);
const TOP_K = 4;

/** EXPLAIN (FORMAT JSON) 的节点：只取本报告用到的字段 */
interface ExplainNode {
  'Node Type'?: string;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: ExplainNode[];
}

/** 单次检索的 EXPLAIN 结果：扫描节点 + 候选行数 + 丢弃行数 + 执行耗时 */
interface ScanSample {
  /** 实际用上的扫描节点类型：数据量小时规划器会退化为 Seq Scan，此时看不到 HNSW 行为 */
  nodeType: string;
  scanRows: number;
  filteredRows: number;
  totalMs: number;
}

/** 中位：单次测量易被首次连接预热与偶发抖动带偏 */
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * 递归找扫描节点：可见性条件的丢弃量记在它身上，靠它判断 OR 过滤有没有把召回走塌。
 * 不限定 Index Scan——语料少时规划器会选 Seq Scan，那种情况也得如实取到口径并在报告里标出节点类型
 */
function findScanNode(node: ExplainNode): ExplainNode | undefined {
  if ((node['Node Type'] ?? '').endsWith('Scan')) return node;
  for (const child of node.Plans ?? []) {
    const found = findScanNode(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * 跑一次带 ANALYZE 的检索 SQL，从计划里取出扫描节点口径。
 * 必须用已装载 hnsw 会话参数的连接：未装载时走的是默认 off 模式，量出来的扫描量与线上不是同一口径
 */
async function explainSearch(
  client: PoolClient,
  vector: number[],
  userId: number,
): Promise<ScanSample> {
  const { rows } = await client.query<Record<string, unknown>>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${SEARCH_CHUNKS_SQL}`,
    [toVectorParam(vector), userId, TOP_K],
  );
  const plan = rows[0]?.['QUERY PLAN'] as
    [{ Plan: ExplainNode; 'Execution Time': number }] | undefined;
  const root = plan?.[0];
  const scan = root ? findScanNode(root.Plan) : undefined;
  return {
    nodeType: scan?.['Node Type'] ?? '未知',
    scanRows: scan?.['Actual Rows'] ?? 0,
    filteredRows: scan?.['Rows Removed by Filter'] ?? 0,
    totalMs: root?.['Execution Time'] ?? 0,
  };
}

/** 默认问题集取知识库文档标题：无参即可用，且保证查询词与语料同域 */
function resolveQueries(documents: Record<string, unknown>[]): string[] {
  const fromEnv = process.env.REPORT_QUERIES?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return documents
    .slice(0, 5)
    .map((document) => String(document.title ?? ''))
    .filter(Boolean);
}

/** 定宽输出：中文列不追求像素对齐，够读即可 */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function format(value: number): string {
  return value.toFixed(1);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const options = {
    chunkSize: config.knowledge.chunkSize,
    chunkOverlap: config.knowledge.chunkOverlap,
    topK: config.knowledge.topK,
    minScore: config.knowledge.minScore,
    embeddingModel: describeEmbeddingModel(config),
    embeddingEndpoint: describeEmbeddingEndpoint(config),
  };
  const embeddings = createEmbeddings(config);
  const pool = createPgPool(config.postgres);
  const store = new PgVectorStore(pool, options);
  // EXPLAIN 与真实检索必须同口径：先把 hnsw 会话参数装到这条连接上
  const client = await pool.connect();
  await client.query(SESSION_PARAMETERS);

  try {
    const chunkCount = await store.countChunks();
    if (chunkCount === 0) {
      console.log('知识库为空：先入库一篇文档再跑本报告');
      return;
    }

    const documents = await store.listAllDocuments();
    const userId = Number(process.env.REPORT_USER_ID ?? documents[0]?.owner_user_id ?? 0);
    const queries = resolveQueries(documents);
    console.log(
      `语料：文档 ${documents.length} 篇 / 片段 ${chunkCount} 条；topK=${TOP_K} minScore=${options.minScore} userId=${userId}`,
    );
    console.log(
      `\n${pad('查询', 24)}${pad('向量化', 10)}${pad('扫描节点', 16)}${pad('扫描候选', 10)}${pad(
        '过滤丢弃',
        10,
      )}${pad('返回(过阈值)', 14)}${pad('检索中位', 10)}EXPLAIN耗时`,
    );

    for (const query of queries) {
      const embedStartedAt = performance.now();
      const vector = await embeddings.embedQuery(query);
      const embedMs = performance.now() - embedStartedAt;

      const samples: number[] = [];
      let hits = await store.searchChunks(vector, { userId, topK: TOP_K });
      for (let index = 0; index < ROUNDS; index += 1) {
        const startedAt = performance.now();
        hits = await store.searchChunks(vector, { userId, topK: TOP_K });
        samples.push(performance.now() - startedAt);
      }
      const scan = await explainSearch(client, vector, userId);
      const kept = hits.filter((hit) => hit.score >= options.minScore).length;

      console.log(
        `${pad(query, 24)}${pad(`${format(embedMs)}ms`, 10)}${pad(scan.nodeType, 16)}${pad(
          String(scan.scanRows),
          10,
        )}${pad(String(scan.filteredRows), 10)}${pad(`${kept}/${hits.length}`, 14)}${pad(
          `${format(median(samples))}ms`,
          10,
        )}${format(scan.totalMs)}ms`,
      );
    }
    console.log(
      '\n「扫描候选 + 过滤丢弃」即本次检索评估过的行数；该值远大于 topK 说明过滤与索引走得不够近，需上调 hnsw.ef_search 或改索引策略。',
    );
    console.log(
      '扫描节点为 Seq Scan 说明语料量还小、规划器没用上 HNSW 索引：要验迭代索引扫描行为，需在真实规模语料上重跑本报告。',
    );
  } finally {
    client.release();
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error('检索报告失败', error);
  process.exitCode = 1;
});
