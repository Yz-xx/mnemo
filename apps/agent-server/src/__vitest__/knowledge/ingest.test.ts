import type { KnowledgeDocument } from '../../entities/knowledge.js';
import type { BoundedGate, GateOutcome } from '../../infrastructure/concurrency/gate.js';
import type { KnowledgeStore } from '../../services/knowledge/index.js';
import type { Logger } from '@mnemo/logger';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeIngest, knowledgeFilePath } from '../../services/knowledge/ingest.js';
import { TEST_ROOT } from '../helpers/fakeEmbeddings.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 临时上传根目录：每个用例独立，结束后整目录删除 */
let uploadDir: string;

beforeEach(() => {
  uploadDir = fs.mkdtempSync(path.join(TEST_ROOT, 'ingest-'));
});

afterEach(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  vi.useRealTimers();
});

/** 造一篇待解析文档：字段只填解析链路会读到的部分 */
function makeDocument(id: string, fileName: string): KnowledgeDocument {
  return {
    id,
    title: fileName,
    knowledgeBaseId: 'kb-1',
    chunks: 0,
    createdAt: '2026-11-05T00:00:00.000Z',
    fileName,
    fileSize: 10,
    mimeType: null,
    status: 'processing',
    failureReason: null,
  };
}

/** 把原始文件写到正式路径，等价于上传接口 rename 之后的现场 */
function writeSourceFile(document: KnowledgeDocument, content: string): void {
  const target = knowledgeFilePath(uploadDir, document.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

/** 内存版存储：只实现解析任务会调用的三个方法 */
class FakeKnowledge {
  readonly contents: { id: string; content: string }[] = [];
  readonly failures: { id: string; reason: string }[] = [];
  pending: KnowledgeDocument[] = [];
  /** 回写结果：false 模拟「解析期间文档被删」 */
  writeResult = true;
  /** 置 true 模拟向量化失败 */
  throwOnIngest = false;

  async ingestContent(id: string, content: string): Promise<boolean> {
    if (this.throwOnIngest) throw new Error('向量化服务不可用');
    this.contents.push({ id, content });
    return this.writeResult;
  }

  async markFailed(id: string, reason: string): Promise<void> {
    this.failures.push({ id, reason });
  }

  async listProcessing(): Promise<KnowledgeDocument[]> {
    return this.pending;
  }
}

/** 闸门替身：按预设序列作答，默认放行 */
class FakeGate {
  acquireCalls = 0;
  released = 0;
  private readonly outcomes: GateOutcome[];

  constructor(outcomes: GateOutcome[] = []) {
    this.outcomes = outcomes;
  }

  async acquire(): Promise<GateOutcome> {
    const outcome = this.outcomes[this.acquireCalls] ?? 'admitted';
    this.acquireCalls += 1;
    return outcome;
  }

  release(): void {
    this.released += 1;
  }

  snapshot() {
    return { inFlight: 0, queued: 0, rejected: 0, maxInFlight: 1, queueLimit: 1 };
  }
}

/** 可挂起的闸门：acquire 返回未决 Promise，由用例显式 resume，用于验证排队期间的取消 */
class PausingGate {
  private resolve?: (outcome: GateOutcome) => void;
  released = 0;

  acquire(): Promise<GateOutcome> {
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  release(): void {
    this.released += 1;
  }

  resume(outcome: GateOutcome = 'admitted'): void {
    this.resolve?.(outcome);
  }

  snapshot() {
    return { inFlight: 1, queued: 0, rejected: 0, maxInFlight: 1, queueLimit: 1 };
  }
}

/** 按依赖组装被测任务：存储与闸门都用替身，只有文件 IO 走真实磁盘 */
function createIngest(
  knowledge: FakeKnowledge,
  gate: BoundedGate = new FakeGate() as unknown as BoundedGate,
) {
  return createKnowledgeIngest({
    knowledge: knowledge as unknown as KnowledgeStore,
    gate,
    logger: logger as unknown as Logger,
    uploadDir,
  });
}

describe('createKnowledgeIngest', () => {
  it('TXT 解析成功后回写正文，并剥掉 BOM', async () => {
    const document = makeDocument('doc-1', '说明.txt');
    writeSourceFile(document, '\uFEFF知识库内容');
    const knowledge = new FakeKnowledge();
    const ingest = createIngest(knowledge);

    ingest.enqueue(document);
    await ingest.drain();

    expect(knowledge.contents).toEqual([{ id: 'doc-1', content: '知识库内容' }]);
    expect(knowledge.failures).toEqual([]);
  });

  it('读取文件失败时标记 failed，并给出中文可读原因', async () => {
    const document = makeDocument('doc-2', '说明.txt');
    const knowledge = new FakeKnowledge();
    const ingest = createIngest(knowledge);

    ingest.enqueue(document);
    await ingest.drain();

    expect(knowledge.contents).toEqual([]);
    expect(knowledge.failures).toEqual([{ id: 'doc-2', reason: '原始文件不存在或已被删除' }]);
  });

  it('向量化失败时标记 failed，不把异常抛出任务', async () => {
    const document = makeDocument('doc-3', '说明.txt');
    writeSourceFile(document, '任意内容');
    const knowledge = new FakeKnowledge();
    knowledge.throwOnIngest = true;
    const ingest = createIngest(knowledge);

    ingest.enqueue(document);
    await ingest.drain();

    expect(knowledge.failures).toEqual([{ id: 'doc-3', reason: '向量化服务不可用' }]);
  });

  it('解析期间文档被删（回写返回 false）时不标记失败，也不写失败原因', async () => {
    const document = makeDocument('doc-4', '说明.txt');
    writeSourceFile(document, '任意内容');
    const knowledge = new FakeKnowledge();
    knowledge.writeResult = false;
    const ingest = createIngest(knowledge);

    ingest.enqueue(document);
    await ingest.drain();

    expect(knowledge.failures).toEqual([]);
  });

  it('同一文档重复入队只执行一次', async () => {
    const document = makeDocument('doc-5', '说明.txt');
    writeSourceFile(document, '任意内容');
    const knowledge = new FakeKnowledge();
    const ingest = createIngest(knowledge);

    ingest.enqueue(document);
    ingest.enqueue(document);
    await ingest.drain();

    expect(knowledge.contents).toHaveLength(1);
  });

  it('启动恢复扫描把 processing 文档全部重新入队', async () => {
    const first = makeDocument('doc-6', 'a.txt');
    const second = makeDocument('doc-7', 'b.txt');
    writeSourceFile(first, '甲');
    writeSourceFile(second, '乙');
    const knowledge = new FakeKnowledge();
    knowledge.pending = [first, second];
    const ingest = createIngest(knowledge);

    await ingest.recover();
    await ingest.drain();

    expect(knowledge.contents.map((item) => item.id).sort()).toEqual(['doc-6', 'doc-7']);
  });

  it('闸门排队超时不判死：等下一轮额度后继续解析', async () => {
    vi.useFakeTimers();
    const document = makeDocument('doc-8', '说明.txt');
    writeSourceFile(document, '任意内容');
    const knowledge = new FakeKnowledge();
    const gate = new FakeGate(['rejected', 'admitted']);
    const ingest = createIngest(knowledge, gate as unknown as BoundedGate);

    ingest.enqueue(document);
    // 第一次申请被拒后进入 5 秒等待，推进定时器让任务重新申请
    await vi.advanceTimersByTimeAsync(5_000);
    await ingest.drain();

    expect(gate.acquireCalls).toBe(2);
    expect(knowledge.contents).toHaveLength(1);
    expect(knowledge.failures).toEqual([]);
  });

  it('等待额度期间文档被删除：取消任务，不再读取与向量化', async () => {
    const document = makeDocument('doc-10', '说明.txt');
    writeSourceFile(document, '任意内容');
    const knowledge = new FakeKnowledge();
    const gate = new PausingGate();
    const ingest = createIngest(knowledge, gate as unknown as BoundedGate);

    ingest.enqueue(document);
    // 让任务先进入额度申请：acquire 返回未决 Promise 后停在原处
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await ingest.discard(document.id);
    gate.resume();
    await ingest.drain();

    expect(knowledge.contents).toEqual([]);
    expect(knowledge.failures).toEqual([]);
  });

  it('删除原始文件：存在则移除，不存在时静默跳过', async () => {
    const document = makeDocument('doc-9', '说明.txt');
    writeSourceFile(document, '任意内容');
    const ingest = createIngest(new FakeKnowledge());

    await ingest.discard(document.id);
    expect(fs.existsSync(knowledgeFilePath(uploadDir, document.id))).toBe(false);
    await expect(ingest.discard(document.id)).resolves.toBeUndefined();
  });
});
