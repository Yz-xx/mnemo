import { describe, expect, it } from 'vitest';
import { createFrameWriter, type FrameScheduler } from '../composables/frameWriter';

/** 手动调度器：把 rAF 换成「攒起来由测试显式执行」，避免依赖真实帧时钟 */
function createManualScheduler() {
  let seq = 0;
  const queue = new Map<number, () => void>();
  const scheduler: FrameScheduler = {
    request: (callback) => {
      seq += 1;
      queue.set(seq, callback);
      return seq;
    },
    cancel: (handle) => {
      queue.delete(handle);
    },
  };
  return {
    scheduler,
    /** 执行当前排程的全部帧回调 */
    runFrame: (): void => {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount: (): number => queue.size,
  };
}

describe('createFrameWriter', () => {
  it('多次 append 只提交一次，提交内容为拼起来的增量', () => {
    const frames = createManualScheduler();
    const commits: string[] = [];
    const writer = createFrameWriter((chunk) => commits.push(chunk), frames.scheduler);

    writer.append('你');
    writer.append('好');
    writer.append('世界');

    expect(commits).toEqual([]);
    frames.runFrame();
    expect(commits).toEqual(['你好世界']);
  });

  it('提交后缓冲清空，下一帧只交出新增量', () => {
    const frames = createManualScheduler();
    const commits: string[] = [];
    const writer = createFrameWriter((chunk) => commits.push(chunk), frames.scheduler);

    writer.append('第一段');
    frames.runFrame();
    writer.append('第二段');
    frames.runFrame();

    expect(commits).toEqual(['第一段', '第二段']);
  });

  it('flush 立即交出未提交的缓冲，并取消待执行的帧', () => {
    const frames = createManualScheduler();
    const commits: string[] = [];
    const writer = createFrameWriter((chunk) => commits.push(chunk), frames.scheduler);

    writer.append('残留');
    writer.flush();

    expect(commits).toEqual(['残留']);
    expect(frames.pendingCount()).toBe(0);
  });

  it('没有缓冲时 flush 不产生空提交', () => {
    const frames = createManualScheduler();
    const commits: string[] = [];
    const writer = createFrameWriter((chunk) => commits.push(chunk), frames.scheduler);

    writer.flush();

    expect(commits).toEqual([]);
  });

  it('提交回调里继续 append 时会在下一帧再提交一次', () => {
    const frames = createManualScheduler();
    const commits: string[] = [];
    const writer = createFrameWriter((chunk) => {
      commits.push(chunk);
      // 模拟「提交正好触发了新的增量」：不能因此吞掉后续内容
      if (chunk === '一') writer.append('二');
    }, frames.scheduler);

    writer.append('一');
    frames.runFrame();
    frames.runFrame();

    expect(commits).toEqual(['一', '二']);
  });
});
