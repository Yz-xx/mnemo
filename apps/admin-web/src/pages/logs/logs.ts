// API 日志：服务端在响应结束时把每个请求的汇总落库，本页只做检索与详情查看。
// 过滤三个维度（路径关键词、请求方法、状态档位）都是服务端能力，前端不本地过滤，
// 避免列表与总数对不上。
import type { ApiLogItem, ApiLogStatusKind } from '@/api/types';
import { onMounted, reactive, ref } from 'vue';
import { listApiLogs } from '@/api';
import { usePagedList } from '@/composables/usePagedList';
import { useLogsDetail } from './useLogsDetail';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

/** 与后端 METHODS 白名单取齐：下拉以外的取值服务端会按「不限」处理 */
const METHOD_OPTIONS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

const STATUS_OPTIONS: { value: ApiLogStatusKind; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'client', label: '4xx 客户端错误' },
  { value: 'server', label: '5xx 服务端错误' },
];

const columns = [
  { key: 'createdAt', label: '时间', width: '170px' },
  { key: 'method', label: '方法', width: '84px' },
  { key: 'path', label: '路径' },
  { key: 'status', label: '状态', width: '80px' },
  { key: 'durationMs', label: '耗时', width: '90px', align: 'right' as const },
  { key: 'userId', label: '用户', width: '80px', align: 'right' as const },
  { key: 'actions', label: '详情', width: '70px', align: 'right' as const },
];

/** 状态色调：2xx 成功、4xx 客户端错误、5xx 服务端错误 */
function statusKindOf(status: number): 'ok' | 'client' | 'server' {
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'ok';
}

/**
 * API 日志页的入口：按关注点收成 filter / table / detail / cells 四组，模板按组取用。
 * 详情弹窗的状态与字段进子 hook，本入口只负责建筛选与列表状态。
 */
export function useLogsPage() {
  const keyword = ref('');
  const method = ref('');
  const statusKind = ref<ApiLogStatusKind>('all');

  const { rows, total, loading, errorMsg, paging } = usePagedList<ApiLogItem>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) =>
      listApiLogs({
        keyword: keyword.value.trim(),
        method: method.value,
        status: statusKind.value,
        page,
        pageSize,
      }),
    errorFallback: '加载接口日志失败',
  });

  const detail = useLogsDetail();

  onMounted(() => void paging.load());

  // 分组包一层 reactive：嵌套在普通对象里的 ref 在模板中不会被解包，包过 reactive 才会
  return {
    filter: reactive({
      keyword,
      method,
      statusKind,
      handleSearch: paging.search,
      METHOD_OPTIONS,
      STATUS_OPTIONS,
    }),
    table: reactive({
      PAGE_SIZE,
      columns,
      rows,
      page: paging.page,
      total,
      loading,
      errorMsg,
      handlePage: paging.goPage,
    }),
    detail: reactive({
      row: detail.detail,
      fields: detail.detailFields,
      open: detail.openDetail,
      close: detail.closeDetail,
    }),
    cells: reactive({ statusKindOf }),
  };
}
