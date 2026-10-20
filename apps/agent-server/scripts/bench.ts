/**
 * 高并发压测脚本（见 docs/adr/0010 决策 17）：对运行中的 agent-server 施压，
 * 采集首 token 时延、整轮时延、503 比例与连接池等待 P95，并与 SLO 目标比对后决定退出码。
 *
 * 前置（三件）：
 *   1. 起 mock 模型：pnpm --filter @mnemo/agent-server run mock:model
 *   2. 让后端指向 mock（示例，实际按 .env 覆盖即可）：
 *      LLM_PROVIDER=deepseek DEEPSEEK_BASE_URL=http://127.0.0.1:8901 DEEPSEEK_API_KEY=mock \
 *      EMBEDDING_PROVIDER=openai EMBEDDING_BASE_URL=http://127.0.0.1:8901 EMBEDDING_API_KEY=mock \
 *      pnpm --filter @mnemo/agent-server run dev
 *   3. 跑压测：BENCH_TOKEN=<登录令牌> pnpm --filter @mnemo/agent-server run bench
 *      （未提供令牌时用 BENCH_USERNAME / BENCH_PASSWORD 走一次登录换取）
 *
 * 可调环境变量：BENCH_BASE_URL / BENCH_CONCURRENCY / BENCH_REQUESTS / BENCH_CRUD_REQUESTS
 */
import process from 'node:process';
import { METRIC } from '../src/infrastructure/observability/metricNames.js';

const BASE_URL = (process.env.BENCH_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 8);
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 40);
const CRUD_REQUESTS = Number(process.env.BENCH_CRUD_REQUESTS ?? 40);

/** SLO 目标：mock 基线，接真实模型后按实测重新校准（见 README 容量基线一节） */
const SLO = {
  firstChunkP95Ms: Number(process.env.SLO_FIRST_CHUNK_P95_MS ?? 1500),
  roundP95Ms: Number(process.env.SLO_ROUND_P95_MS ?? 15000),
  max503Ratio: Number(process.env.SLO_MAX_503_RATIO ?? 0.01),
  poolWaitP95Ms: Number(process.env.SLO_POOL_WAIT_P95_MS ?? 50),
};

interface ChatSample {
  status: number;
  firstChunkMs?: number;
  roundMs: number;
}

/** 最近秩分位数：与 observability/metrics.ts 同口径，样本少时退化为最大值 */
function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)];
}

/** 口令传输加密：与客户端一致，取 RSA 公钥用 OAEP/SHA-256 加密后提交 */
async function encryptPassword(password: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/auth/public-key`);
  const { publicKey } = (await response.json()) as { publicKey: JsonWebKey };
  const key = await crypto.subtle.importKey(
    'jwk',
    publicKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    key,
    new TextEncoder().encode(password),
  );
  return Buffer.from(encrypted).toString('base64');
}

/** 取压测令牌：优先用 BENCH_TOKEN，否则用账号口令登录换一枚 */
async function resolveToken(): Promise<string> {
  const token = process.env.BENCH_TOKEN;
  if (token) return token;
  const username = process.env.BENCH_USERNAME;
  const password = process.env.BENCH_PASSWORD;
  if (!username || !password) {
    throw new Error('需设置 BENCH_TOKEN，或同时设置 BENCH_USERNAME 与 BENCH_PASSWORD');
  }
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: await encryptPassword(password) }),
  });
  const body = (await response.json()) as { token?: string; message?: string };
  if (!response.ok || !body.token) throw new Error(`登录失败：${body.message ?? response.status}`);
  return body.token;
}

/** 读一次 SSE 流：记录首块正文到达的时刻，读到流结束返回整轮耗时 */
async function readChatStream(response: Response, startedAt: number): Promise<ChatSample> {
  let firstChunkMs: number | undefined;
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, roundMs: performance.now() - startedAt };

  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const line = block.split('\n').find((item) => item.startsWith('data: '));
      if (!line || line.includes('[DONE]')) continue;
      try {
        const event = JSON.parse(line.slice(6)) as { type?: string };
        if (event.type === 'token' && firstChunkMs === undefined) {
          firstChunkMs = performance.now() - startedAt;
        }
      } catch {
        // 非 JSON 数据块（注释行等）直接跳过，不影响时延采集
      }
    }
  }
  return { status: response.status, firstChunkMs, roundMs: performance.now() - startedAt };
}

/** 发一轮流式对话并采集时延；503 等非 200 响应只记状态码 */
async function runChat(token: string, index: number): Promise<ChatSample> {
  const startedAt = performance.now();
  const response = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: `压测请求 ${index}：请简要介绍一下你自己` }),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status, roundMs: performance.now() - startedAt };
  }
  return readChatStream(response, startedAt);
}

/** 有界并发驱动：固定 worker 数反复取任务，避免一次性起满并发把进程拖垮 */
async function runPool<T>(
  total: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(total);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= total) return;
      results[index] = await task(index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 打非流式接口（会话列表），测普通读写档的吞吐与时延 */
async function runCrud(token: string, _index: number): Promise<ChatSample> {
  const startedAt = performance.now();
  const response = await fetch(`${BASE_URL}/api/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await response.body?.cancel();
  return { status: response.status, roundMs: performance.now() - startedAt };
}

/** 读就绪检查，取连接池等待 P95 与各档累计拒绝数 */
async function readReadiness(): Promise<{ poolWaitP95Ms: number; rejected: number }> {
  const response = await fetch(`${BASE_URL}/api/health/ready`);
  const body = (await response.json()) as {
    gates?: { rejected: number }[];
    metrics?: { histograms?: Record<string, { p95Ms: number }> };
  };
  // 池等待 P95 取自进程内最近一段直方图窗口（默认最近 1024 个样本），含本次压测前的历史样本；
  // 要精确对应本轮压测，应在冷启动后紧接施压，或后续改为按增量样本统计
  return {
    poolWaitP95Ms: body.metrics?.histograms?.[METRIC.POOL_WAIT]?.p95Ms ?? 0,
    rejected: (body.gates ?? []).reduce((sum, gate) => sum + gate.rejected, 0),
  };
}

function format(value: number): string {
  return value.toFixed(1);
}

async function main(): Promise<void> {
  const token = await resolveToken();
  console.log(
    `压测目标 ${BASE_URL}，并发 ${CONCURRENCY}，对话 ${REQUESTS} 次，读写 ${CRUD_REQUESTS} 次`,
  );

  const chats = await runPool(REQUESTS, CONCURRENCY, (index) => runChat(token, index));
  const crud = await runPool(CRUD_REQUESTS, CONCURRENCY, (index) => runCrud(token, index));
  const { poolWaitP95Ms, rejected } = await readReadiness();

  const firstChunks = chats
    .map((sample) => sample.firstChunkMs)
    .filter((value): value is number => value !== undefined);
  const roundP95 = percentile(
    chats.map((sample) => sample.roundMs),
    0.95,
  );
  const firstChunkP95 = percentile(firstChunks, 0.95);
  const crudP95 = percentile(
    crud.map((sample) => sample.roundMs),
    0.95,
  );
  const overloaded = chats.filter((sample) => sample.status === 503).length;
  const overloadRatio = overloaded / REQUESTS;
  const failed = chats.filter((sample) => sample.status !== 200 && sample.status !== 503).length;

  console.log('\n指标        P50      P95      最大');
  console.log(
    `首 token    ${format(percentile(firstChunks, 0.5))}    ${format(firstChunkP95)}    ${format(Math.max(0, ...firstChunks))}`,
  );
  console.log(
    `整轮        ${format(
      percentile(
        chats.map((s) => s.roundMs),
        0.5,
      ),
    )}    ${format(roundP95)}    ${format(Math.max(0, ...chats.map((s) => s.roundMs)))}`,
  );
  console.log(
    `读写接口    ${format(
      percentile(
        crud.map((s) => s.roundMs),
        0.5,
      ),
    )}    ${format(crudP95)}    ${format(Math.max(0, ...crud.map((s) => s.roundMs)))}`,
  );
  console.log(
    `池等待 P95  ${format(poolWaitP95Ms)}ms，闸门累计拒绝 ${rejected}，503 ${overloaded}/${REQUESTS}`,
  );
  if (failed > 0) console.log(`非 200/503 的失败响应 ${failed} 次，需排查`);

  const checks: { name: string; actual: string; target: string; pass: boolean }[] = [
    {
      name: '首 token P95',
      actual: `${format(firstChunkP95)}ms`,
      target: `≤ ${SLO.firstChunkP95Ms}ms`,
      pass: firstChunkP95 <= SLO.firstChunkP95Ms,
    },
    {
      name: '整轮 P95',
      actual: `${format(roundP95)}ms`,
      target: `≤ ${SLO.roundP95Ms}ms`,
      pass: roundP95 <= SLO.roundP95Ms,
    },
    {
      name: '503 比例',
      actual: `${(overloadRatio * 100).toFixed(2)}%`,
      target: `≤ ${(SLO.max503Ratio * 100).toFixed(2)}%`,
      pass: overloadRatio <= SLO.max503Ratio && failed === 0,
    },
    {
      name: '池等待 P95',
      actual: `${format(poolWaitP95Ms)}ms`,
      target: `≤ ${SLO.poolWaitP95Ms}ms`,
      pass: poolWaitP95Ms <= SLO.poolWaitP95Ms,
    },
  ];

  console.log('\nSLO 判定');
  for (const check of checks) {
    console.log(
      `${check.pass ? '通过' : '未达标'}  ${check.name}  实际 ${check.actual}  目标 ${check.target}`,
    );
  }
  if (checks.some((check) => !check.pass)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('压测失败', error);
  process.exitCode = 1;
});
