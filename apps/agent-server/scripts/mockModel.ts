/**
 * 压测用 mock 模型服务（OpenAI 兼容协议，见 docs/adr/0010 决策 17）。
 *
 * 不调用真实模型，按固定节奏吐字：这样压测聚焦服务端的编排、闸门与背压，
 * 而不是模型算力本身。对话与向量两个接口都实现，便于用一套 mock 同时喂 4 个模型配置项。
 *
 * 启动：pnpm --filter @repo/agent-server run mock:model
 * 可调环境变量：MOCK_PORT / MOCK_FIRST_DELAY_MS / MOCK_TOKEN_DELAY_MS / MOCK_TOKEN_COUNT / MOCK_EMBED_DIM
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8901);
/** 首块产出前延迟：模拟首 token 时延，压测据此区分「排队慢」与「生成慢」 */
const FIRST_DELAY_MS = Number(process.env.MOCK_FIRST_DELAY_MS ?? 50);
const TOKEN_DELAY_MS = Number(process.env.MOCK_TOKEN_DELAY_MS ?? 10);
const TOKEN_COUNT = Number(process.env.MOCK_TOKEN_COUNT ?? 20);
const EMBED_DIM = Number(process.env.MOCK_EMBED_DIM ?? 64);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 收集请求体并解析 JSON：mock 只读 stream / input / model 几个字段 */
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** 逐块输出 OpenAI 风格 SSE；首块额外延迟，末块带 finish_reason 与 [DONE] */
async function streamCompletion(res: http.ServerResponse): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  await sleep(FIRST_DELAY_MS);
  for (let i = 0; i < TOKEN_COUNT; i += 1) {
    const chunk = {
      id: 'mock-chunk',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-chat',
      choices: [
        {
          index: 0,
          delta: { content: i === 0 ? '压测回答：' : `片段${i} ` },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await sleep(TOKEN_DELAY_MS);
  }
  res.write(
    `data: ${JSON.stringify({
      id: 'mock-chunk',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-chat',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function completionBody(): unknown {
  return {
    id: 'mock-completion',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-chat',
    choices: [
      { index: 0, message: { role: 'assistant', content: '压测回答' }, finish_reason: 'stop' },
    ],
  };
}

/** 向量化响应：输入可能是单条字符串或数组，统一按条数回同等数量的向量 */
function embeddingsBody(body: Record<string, unknown>): unknown {
  const input = body.input;
  const count = Array.isArray(input) ? input.length : 1;
  return {
    object: 'list',
    model: body.model ?? 'mock-embed',
    data: Array.from({ length: count }, (_value, index) => ({
      object: 'embedding',
      index,
      embedding: new Array(EMBED_DIM).fill(0.01),
    })),
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  void (async () => {
    // 就绪探测走这里：任何 200 都算可达
    if (req.method === 'GET' && url.startsWith('/models')) {
      sendJson(res, { object: 'list', data: [{ id: 'mock-chat', object: 'model' }] });
      return;
    }
    if (req.method === 'POST' && url.startsWith('/embeddings')) {
      sendJson(res, embeddingsBody(await readJson(req)));
      return;
    }
    if (req.method === 'POST' && url.startsWith('/chat/completions')) {
      const body = await readJson(req);
      if (body.stream === true) {
        await streamCompletion(res);
      } else {
        sendJson(res, completionBody());
      }
      return;
    }
    res.writeHead(404).end();
  })();
});

server.listen(PORT, () => {
  console.log(`mock 模型服务已启动：http://127.0.0.1:${PORT}`);
});
