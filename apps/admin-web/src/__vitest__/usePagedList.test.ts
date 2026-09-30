import type { PageResult } from '@/api/types';
import { describe, expect, it, vi } from 'vitest';
import { usePagedList } from '@/composables/usePagedList';

/** 构造一页取数结果：多数用例只关心 items 与 total，页码与每页条数取默认值即可 */
function pageOf(items: string[], page = 1, total = items.length): PageResult<string> {
  return { items, total, page, pageSize: 10 };
}

describe('usePagedList 分页取数', () => {
  it('先发出的请求后到达时被丢弃，不覆盖已渲染的最新一页', async () => {
    // 第一页的请求一直挂起不回，第二页立即返回，复现「先发后到」的竞态
    let resolveFirst: ((value: PageResult<string>) => void) | undefined;
    const fetcher = vi.fn(({ page }: { page: number; pageSize: number }) => {
      if (page === 1) {
        return new Promise<PageResult<string>>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(pageOf(['第二页'], 2, 2));
    });

    const list = usePagedList({ pageSize: 10, fetcher, errorFallback: '加载失败' });

    const first = list.load();
    const second = list.goPage(2);
    await second;

    // 迟到的第一页响应此刻才回来，不得覆盖已经渲染出来的第二页
    resolveFirst?.(pageOf(['第一页'], 1, 2));
    await first;

    expect(list.rows.value).toEqual(['第二页']);
    expect(list.total.value).toBe(2);
  });

  it('过期请求不得提前熄掉最新请求的加载态', async () => {
    // 两页都在途，且先发出的那条先回来：此刻最新请求仍在加载，加载态必须保持，
    // 否则用户会在第二页数据到达前看到一次空列表闪动
    let resolveFirst: ((value: PageResult<string>) => void) | undefined;
    let resolveSecond: ((value: PageResult<string>) => void) | undefined;
    const fetcher = vi.fn(({ page }: { page: number; pageSize: number }) => {
      return new Promise<PageResult<string>>((resolve) => {
        if (page === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });

    const list = usePagedList({ pageSize: 10, fetcher, errorFallback: '加载失败' });

    const first = list.load();
    const second = list.goPage(2);

    resolveFirst?.(pageOf(['第一页'], 1, 2));
    await first;
    expect(list.loading.value).toBe(true);

    resolveSecond?.(pageOf(['第二页'], 2, 2));
    await second;
    expect(list.loading.value).toBe(false);
    expect(list.rows.value).toEqual(['第二页']);
  });

  it('取数成功后填充行与总数，并熄灭加载态、清空上一次的错误', async () => {
    const fetcher = vi.fn(() => Promise.resolve(pageOf(['甲', '乙'], 1, 2)));
    const list = usePagedList({ pageSize: 10, fetcher, errorFallback: '加载失败' });

    await list.load();

    expect(list.rows.value).toEqual(['甲', '乙']);
    expect(list.total.value).toBe(2);
    expect(list.loading.value).toBe(false);
    expect(list.errorMsg.value).toBe('');
  });

  it('取数失败时展示后端给出的可读原因', async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error('后端忙不过来')));
    const list = usePagedList({ pageSize: 10, fetcher, errorFallback: '加载失败' });

    await list.load();

    expect(list.errorMsg.value).toBe('后端忙不过来');
    expect(list.loading.value).toBe(false);
  });

  it('错误没有可读原因时回落调用方传入的兜底文案', async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error('')));
    const list = usePagedList({ pageSize: 10, fetcher, errorFallback: '加载失败' });

    await list.load();

    expect(list.errorMsg.value).toBe('加载失败');
  });

  it('搜索先回到第一页再取数，避免停在高页码后筛出空列表', async () => {
    const fetcher = vi.fn(({ page }: { page: number; pageSize: number }) =>
      Promise.resolve(pageOf([], page, 0)),
    );
    const list = usePagedList({ pageSize: 10, fetcher, errorFallback: '加载失败' });

    await list.goPage(3);
    expect(list.page.value).toBe(3);

    await list.search();

    expect(list.page.value).toBe(1);
    expect(fetcher).toHaveBeenLastCalledWith({ page: 1, pageSize: 10 });
  });

  it('每次取数前重置页内临时状态，选择不跨页保留', async () => {
    const onReset = vi.fn();
    const fetcher = vi.fn(() => Promise.resolve(pageOf([], 1, 0)));
    const list = usePagedList({ pageSize: 10, fetcher, errorFallback: '加载失败', onReset });

    await list.load();
    await list.goPage(2);

    expect(onReset).toHaveBeenCalledTimes(2);
  });
});
