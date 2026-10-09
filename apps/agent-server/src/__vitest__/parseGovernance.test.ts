import type { AppConfig, GateConfig } from '../configuration/config/index.js';
import { describe, expect, it } from 'vitest';
import { ParseGovernance, ParseOverloadedError } from '../files/parseGovernance.js';

/** 只填解析闸门会读取的字段：本组用例关注水位与降级，不需要完整配置 */
function makeGovernance(parse: GateConfig): ParseGovernance {
  return new ParseGovernance({ concurrency: { parse } } as unknown as AppConfig);
}

/** 冲出微任务队列：让闸门内部的 await / .then 走完 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('ParseGovernance 解析闸门', () => {
  it('按额度执行任务并原样返回结果', async () => {
    const governance = makeGovernance({
      maxInFlight: 2,
      softLimit: 1,
      queueLimit: 8,
      queueTimeoutMs: 1000,
    });

    await expect(governance.run(async () => '正文')).resolves.toBe('正文');
  });

  it('额度用毕即归还，后续解析照常进行', async () => {
    const governance = makeGovernance({
      maxInFlight: 1,
      softLimit: 1,
      queueLimit: 0,
      queueTimeoutMs: 1000,
    });

    await expect(governance.run(async () => 1)).resolves.toBe(1);
    await expect(governance.run(async () => 2)).resolves.toBe(2);
  });

  it('任务抛错也归还额度，不把额度漏在里面', async () => {
    const governance = makeGovernance({
      maxInFlight: 1,
      softLimit: 1,
      queueLimit: 0,
      queueTimeoutMs: 1000,
    });

    await expect(
      governance.run(async () => {
        throw new Error('解析失败');
      }),
    ).rejects.toThrow('解析失败');
    // 上一次抛错若漏还额度，这里会直接过载拒绝
    await expect(governance.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('硬水位已满时直接拒绝，按过载抛出而不排队', async () => {
    const governance = makeGovernance({
      maxInFlight: 1,
      softLimit: 1,
      queueLimit: 0,
      queueTimeoutMs: 1000,
    });
    let release: () => void = () => undefined;
    const holding = governance.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await flush();

    await expect(governance.run(async () => 'x')).rejects.toThrowError(ParseOverloadedError);

    release();
    await holding;
  });

  it('排队等待超时即按过载拒绝，不无限等待', async () => {
    const governance = makeGovernance({
      maxInFlight: 2,
      softLimit: 1,
      queueLimit: 1,
      queueTimeoutMs: 20,
    });
    // 第一轮占住软水位内的额度并挂住，第二轮进入队列后等待超时
    let release: () => void = () => undefined;
    const holding = governance.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await flush();

    await expect(governance.run(async () => 'x')).rejects.toThrowError(ParseOverloadedError);

    release();
    await holding;
  });
});
