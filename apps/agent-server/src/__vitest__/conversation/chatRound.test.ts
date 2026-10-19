import type { ChatStreamFrame } from '@repo/reusable';
import { describe, expect, it } from 'vitest';
import { createChatRound } from '../../services/conversation/round.js';

/** 单个订阅者的待发队列上限（与实现内的常量一致，用于构造积压超限场景） */
const MAX_PENDING_PER_SUBSCRIBER = 4096;

/** 收集一个订阅生成器直到它自然结束 */
async function collect(stream: AsyncGenerator<ChatStreamFrame>): Promise<ChatStreamFrame[]> {
  const frames: ChatStreamFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

describe('createChatRound', () => {
  it('发布事件分配单调递增序号，lastSeq 反映日志右边界', () => {
    const round = createChatRound({
      id: 'r-1',
      userId: 1,
      maxDurationMs: 10_000,
      maxLogFrames: 10,
    });

    round.publish({ type: 'token', content: 'a' });
    round.publish({ type: 'token', content: 'b' });

    expect(round.lastSeq).toBe(2);
  });

  it('订阅者先重放断点之后的日志，再接上实时帧', async () => {
    const round = createChatRound({
      id: 'r-1',
      userId: 1,
      maxDurationMs: 10_000,
      maxLogFrames: 10,
    });
    round.publish({ type: 'token', content: 'a' });
    round.publish({ type: 'token', content: 'b' });

    const controller = new AbortController();
    // 从 seq 1 之后续读：已消费的 a 不再补发
    const consuming = collect(round.subscribe(1, controller.signal));
    round.publish({ type: 'token', content: 'c' });
    round.finish();

    expect((await consuming).map((frame) => frame.seq)).toEqual([2, 3]);
  });

  it('日志超过帧数上限时丢弃最老帧，重放窗口右移', async () => {
    const round = createChatRound({
      id: 'r-1',
      userId: 1,
      maxDurationMs: 10_000,
      maxLogFrames: 2,
    });
    round.publish({ type: 'token', content: 'a' });
    round.publish({ type: 'token', content: 'b' });
    round.publish({ type: 'token', content: 'c' });
    round.finish();

    const frames = await collect(round.subscribe(0, new AbortController().signal));

    expect(frames.map((frame) => frame.event)).toEqual([
      { type: 'token', content: 'b' },
      { type: 'token', content: 'c' },
    ]);
  });

  it('订阅者断开只退订本轮：回调 onIdle，轮次本身不结束', async () => {
    let idleCalls = 0;
    const round = createChatRound({
      id: 'r-1',
      userId: 1,
      maxDurationMs: 10_000,
      maxLogFrames: 10,
      onIdle: () => {
        idleCalls += 1;
      },
    });
    const controller = new AbortController();
    const consuming = collect(round.subscribe(0, controller.signal));
    expect(round.subscriberCount).toBe(1);

    controller.abort();
    await consuming;

    expect(round.subscriberCount).toBe(0);
    expect(idleCalls).toBe(1);
    // 断开只是退订：生成继续在后台跑，故轮次未结束
    expect(round.ended).toBe(false);
  });

  it('订阅者峰值反映重连：先后两次订阅记为峰值 2', async () => {
    const round = createChatRound({
      id: 'r-1',
      userId: 1,
      maxDurationMs: 10_000,
      maxLogFrames: 10,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = round.subscribe(0, firstController.signal).next();
    const second = round.subscribe(0, secondController.signal).next();
    expect(round.subscriberCount).toBe(2);

    firstController.abort();
    secondController.abort();
    await Promise.all([first, second]);

    expect(round.stats().subscriberPeak).toBe(2);
  });

  it('请求中止只置原因并打信号，收尾留给轮次任务；中止后仍能补发 error 帧', async () => {
    const round = createChatRound({
      id: 'r-1',
      userId: 1,
      maxDurationMs: 10_000,
      maxLogFrames: 10,
    });
    const controller = new AbortController();
    const consuming = collect(round.subscribe(0, controller.signal));

    round.abort('user');

    expect(round.abortReason).toBe('user');
    expect(round.signal.aborted).toBe(true);
    // 中止不在此处收尾：否则中止原因对应的 error 帧会因 ended 被忽略
    expect(round.ended).toBe(false);
    round.publish({ type: 'error', message: '本轮已停止生成' });
    round.finish();

    expect((await consuming).map((frame) => frame.event)).toEqual([
      { type: 'error', message: '本轮已停止生成' },
    ]);
    expect(round.ended).toBe(true);
  });

  it('超过单轮最长时长后自动中止', async () => {
    const round = createChatRound({
      id: 'r-1',
      userId: 1,
      maxDurationMs: 10,
      maxLogFrames: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(round.abortReason).toBe('timeout');
    expect(round.signal.aborted).toBe(true);
  });

  it('收尾后发布的事件一律忽略，日志不再增长', () => {
    const round = createChatRound({
      id: 'r-1',
      userId: 1,
      maxDurationMs: 10_000,
      maxLogFrames: 10,
    });
    round.finish();

    // 模型迟到的 token 不该续写进已收尾的轮次
    round.publish({ type: 'token', content: '迟到的' });

    expect(round.lastSeq).toBe(0);
  });

  it('订阅者积压超过队列上限即被摘除，不再补发这批帧', async () => {
    const round = createChatRound({
      id: 'r-1',
      userId: 1,
      maxDurationMs: 10_000,
      maxLogFrames: 10_000,
    });
    const controller = new AbortController();
    const first = round.subscribe(0, controller.signal).next();
    expect(round.subscriberCount).toBe(1);

    // 订阅者一直不消费：塞满其待发队列，最后一帧触发超限摘除
    for (let i = 0; i <= MAX_PENDING_PER_SUBSCRIBER; i += 1) {
      round.publish({ type: 'token', content: 'x' });
    }

    expect(await first).toEqual({ done: true, value: undefined });
    expect(round.subscriberCount).toBe(0);
  });
});
