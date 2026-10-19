import type { PageResult } from '@/api/types';
import type { Ref } from 'vue';
import { ref, shallowRef } from 'vue';

/** 分页取数需要的外部输入：筛选条件不进这里，由调用方的 fetcher 闭包注入 */
export interface PagedListOptions<T> {
  pageSize: number;
  fetcher: (params: { page: number; pageSize: number }) => Promise<PageResult<T>>;
  /** 取数失败且后端没给出可读原因时的兜底文案，各页措辞不同故由调用方传入 */
  errorFallback: string;
  /** 每次取数前重置页内临时状态（如已勾选项）：选择随列表内容失效，不做跨页保留 */
  onReset?: () => void;
}

/** 页码与取数动作：与列表状态分开放，页面按组取用，免得接口越摊越宽 */
export interface PagedListPaging {
  page: Ref<number>;
  load: () => Promise<void>;
  search: () => Promise<void>;
  goPage: (next: number) => Promise<void>;
}

/** 分页列表对页面暴露的接口：页面读状态、翻页取数，错误文案的展示交给页面模板 */
export interface PagedList<T> {
  rows: Ref<T[]>;
  total: Ref<number>;
  loading: Ref<boolean>;
  errorMsg: Ref<string>;
  paging: PagedListPaging;
}

/**
 * 后台列表页的分页取数：管住「页码 / 每页条数 / 加载中 / 错误」四件事与并发竞态，
 * 页面的筛选条件与行数据形状各不相同，因此只把取数动作交给调用方。
 */
export function usePagedList<T>(options: PagedListOptions<T>): PagedList<T> {
  const { pageSize, fetcher, errorFallback, onReset } = options;

  // 行数组每次整体替换、从不就地改单行，shallowRef 足以驱动刷新且免去深层代理开销
  const rows = shallowRef<T[]>([]);
  const total = ref(0);
  const page = ref(1);
  const loading = ref(false);
  const errorMsg = ref('');

  // 请求序号：快速翻页时先发出的响应可能后到，只认最后一次发出的请求
  let seq = 0;

  async function load(): Promise<void> {
    const id = ++seq;
    loading.value = true;
    errorMsg.value = '';
    onReset?.();
    try {
      const result = await fetcher({ page: page.value, pageSize });
      if (id !== seq) return;
      rows.value = result.items;
      total.value = result.total;
    } catch (e) {
      if (id !== seq) return;
      errorMsg.value = (e as Error).message || errorFallback;
    } finally {
      // 过期请求不得收尾，否则会提前熄掉最新请求的 loading
      if (id === seq) loading.value = false;
    }
  }

  /** 搜索：先回到第一页再取数，避免停在高页码后筛出空列表 */
  async function search(): Promise<void> {
    page.value = 1;
    await load();
  }

  async function goPage(next: number): Promise<void> {
    page.value = next;
    await load();
  }

  return { rows, total, loading, errorMsg, paging: { page, load, search, goPage } };
}
