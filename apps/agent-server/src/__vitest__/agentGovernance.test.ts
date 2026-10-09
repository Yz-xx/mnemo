import type { AppConfig, GateConfig } from '../configuration/config/index.js';
import type { FileStore } from '../files/store/index.js';
import type { KnowledgeStore } from '../rag/index.js';
import { HumanMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitOpenError } from '../concurrency/circuitBreaker.js';
import { AgentService } from '../llm/agent.js';
import { ModelOverloadedError } from '../llm/modelGovernance.js';
import { DISABLED_VISION } from '../llm/vision.js';

/**
 * 替身开关：hold 让模型调用挂住（用来占住额度），fail 让模型调用直接失败（用来喂熔断）；
 * release / invokeRelease 由用例显式放行，避免留下永远 pending 的 Promise。
 */
const captured = vi.hoisted(() => ({
  mode: 'hold' as 'hold' | 'fail',
  release: undefined as undefined | (() => void),
  invokeRelease: undefined as undefined | (() => void),
}));

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>();
  return {
    ...actual,
    createAgent: () => ({
      async stream() {
        if (captured.mode === 'fail') throw new Error('模型服务不可用');
        // 挂到用例放行为止：第一轮占着模型额度且不产出任何事件
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<unknown>>((resolve) => {
                  captured.release = () => resolve({ done: true, value: undefined });
                }),
            };
          },
        };
      },
    }),
  };
});

vi.mock('../llm/model.js', () => ({
  // 摘要走 model.invoke：同样可挂住，用来占住摘要闸门
  createChatModel: () => ({
    invoke: () =>
      new Promise((resolve) => {
        captured.invokeRelease = () => resolve({ content: '摘要正文' });
      }),
  }),
}));

/** 默认闸门容量足够：只在本用例关心的那一档上覆盖 */
const GATE: GateConfig = { maxInFlight: 8, softLimit: 6, queueLimit: 32, queueTimeoutMs: 1000 };

/** 只填 AgentService 构造会读取的字段：本组用例关注治理行为，不需要完整配置 */
function makeService(overrides: Partial<AppConfig['concurrency']> = {}): AgentService {
  const config = {
    llm: {
      provider: 'ollama',
      temperature: 0.3,
      thinking: false,
      context: { windowTokens: 8192, triggerRatio: 0.7, keepRatio: 0.4, toolRatio: 0.3 },
    },
    concurrency: {
      model: GATE,
      summary: GATE,
      circuitFailureThreshold: 5,
      circuitCooldownMs: 30000,
      ...overrides,
    },
    ollama: { visionModel: '' },
  } as unknown as AppConfig;
  return new AgentService(
    config,
    {} as unknown as KnowledgeStore,
    {} as FileStore,
    DISABLED_VISION,
  );
}

const messages = [new HumanMessage('问题')];
/** 冲出微任务队列：让闸门内部的 .then / await 走完 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 消费整轮流：用于断言「本轮在发起真实调用前就抛错」 */
async function drain(service: AgentService): Promise<void> {
  for await (const _event of service.stream(messages, { userId: 1, fileIds: [] })) {
    // 替身不产出事件
  }
}

describe('AgentService 模型侧治理', () => {
  beforeEach(() => {
    captured.mode = 'hold';
    captured.release = undefined;
    captured.invokeRelease = undefined;
  });

  it('模型闸门排队超时即按过载拒绝，不无限等待', async () => {
    const service = makeService({
      model: { maxInFlight: 2, softLimit: 1, queueLimit: 1, queueTimeoutMs: 20 },
    });
    // 第一轮占住软水位内的一个额度并挂住不产出，第二轮进入队列后等待超时
    const first = service.stream(messages, { userId: 1, fileIds: [] });
    const holding = first.next();
    await flush();

    const second = service.stream(messages, { userId: 1, fileIds: [] });
    await expect(second.next()).rejects.toThrowError(ModelOverloadedError);

    captured.release?.();
    await holding;
  });

  it('排队期间客户端离开即撤销申请，按中断收尾而不是过载拒绝', async () => {
    const service = makeService({
      model: { maxInFlight: 2, softLimit: 1, queueLimit: 1, queueTimeoutMs: 1000 },
    });
    // 第一轮先占住软水位内的一个额度，第二轮才会真正进入队列
    const first = service.stream(messages, { userId: 1, fileIds: [] });
    const holding = first.next();
    await flush();

    const controller = new AbortController();
    const second = service.stream(messages, {
      userId: 1,
      fileIds: [],
      signal: controller.signal,
    });
    const queued = second.next();
    await flush();
    controller.abort();

    await expect(queued).rejects.toThrow('本轮对话已中断');

    captured.release?.();
    await holding;
  });

  it('依赖连续失败达阈值后快速失败，不再发起真实调用', async () => {
    captured.mode = 'fail';
    const service = makeService({ circuitFailureThreshold: 1 });

    await expect(drain(service)).rejects.toThrow('模型服务不可用');
    await expect(drain(service)).rejects.toThrowError(CircuitOpenError);
  });

  it('摘要额度被占时直接拒绝，交由上层降级而不是排队等待', async () => {
    const service = makeService({
      summary: { maxInFlight: 1, softLimit: 1, queueLimit: 0, queueTimeoutMs: 1000 },
    });
    const first = service.summarize('把这段对话压成摘要');
    await flush();

    await expect(service.summarize('再压一次')).rejects.toThrowError(ModelOverloadedError);

    captured.invokeRelease?.();
    await expect(first).resolves.toBe('摘要正文');
  });
});
