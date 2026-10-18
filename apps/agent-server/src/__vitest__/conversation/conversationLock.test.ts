import { describe, expect, it } from 'vitest';
import {
  ConversationBusyError,
  createConversationLock,
} from '../../infrastructure/concurrency/lock.js';

/** 等待若干毫秒：用于让「上一轮」占住会话 */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('createConversationLock', () => {
  it('同一会话的任务按先到先得串行执行，不交错', async () => {
    const lock = createConversationLock(1000);
    const order: string[] = [];

    const first = lock.run('c-1', async () => {
      order.push('开始-1');
      await delay(20);
      order.push('结束-1');
    });
    const second = lock.run('c-1', async () => {
      order.push('开始-2');
      order.push('结束-2');
    });

    await Promise.all([first, second]);
    // 第二轮必须等第一轮整轮收尾，否则两个回答会交错写进同一条会话
    expect(order).toEqual(['开始-1', '结束-1', '开始-2', '结束-2']);
  });

  it('不同会话的任务互不阻塞', async () => {
    const lock = createConversationLock(1000);
    const order: string[] = [];

    const slow = lock.run('c-1', async () => {
      await delay(20);
      order.push('慢');
    });
    const fast = lock.run('c-2', async () => {
      order.push('快');
    });

    await Promise.all([slow, fast]);
    // 只按会话维度互斥，另一个会话不受影响
    expect(order).toEqual(['快', '慢']);
  });

  it('上一轮久占不释放时，等待超过上限抛 ConversationBusyError', async () => {
    const lock = createConversationLock(20);
    let release: () => void = () => undefined;
    const first = lock.run(
      'c-1',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await delay(40);
    await expect(lock.run('c-1', async () => '不会执行')).rejects.toBeInstanceOf(
      ConversationBusyError,
    );

    release();
    await first;
  });

  it('前一轮失败不影响后续任务继续排队执行', async () => {
    const lock = createConversationLock(1000);

    const failed = lock.run('c-1', async () => {
      throw new Error('上一轮失败');
    });
    const next = lock.run('c-1', async () => '第二轮');

    await expect(failed).rejects.toThrow('上一轮失败');
    // 一次异常不能卡死整条会话链，否则该会话再也发不出消息
    await expect(next).resolves.toBe('第二轮');
  });
});
