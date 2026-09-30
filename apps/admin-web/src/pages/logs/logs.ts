// API 日志：服务端在响应结束时把每个请求的汇总落库，本页只做检索与详情查看。
// 过滤三个维度（路径关键词、请求方法、状态档位）都是服务端能力，前端不本地过滤，
// 避免列表与总数对不上。
import type { ApiLogItem, ApiLogStatusKind } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import { formatTime } from '@repo/shared';
import { listApiLogs } from '@/api';
import { usePagedList } from '@/composables/usePagedList';

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

/** API 日志页的全部状态与动作：模板只做展示，逻辑集中在此以便单独复用与测试 */
export function useLogsPage() {
  const keyword = ref('');
  const method = ref('');
  const statusKind = ref<ApiLogStatusKind>('all');

  /** 详情弹窗中的这一条：为空表示未打开 */
  const detail = ref<ApiLogItem | null>(null);

  /** 状态色调：2xx 成功、4xx 客户端错误、5xx 服务端错误 */
  function statusKindOf(status: number): 'ok' | 'client' | 'server' {
    if (status >= 500) return 'server';
    if (status >= 400) return 'client';
    return 'ok';
  }

  /** 详情字段：值可能为空，统一用「—」占位，避免弹窗出现空白行 */
  const detailFields = computed(() => {
    const row = detail.value;
    if (!row) return [];
    return [
      { label: '请求 ID', value: row.requestId },
      { label: '请求', value: `${row.method} ${row.path}` },
      { label: '状态与耗时', value: `${row.status} · ${row.durationMs} ms` },
      { label: '用户', value: row.userId === null ? '未登录 / 超级令牌' : `#${row.userId}` },
      { label: '时间', value: formatTime(row.createdAt) },
      { label: '查询串', value: row.queryParams ?? '—' },
      { label: '请求体', value: row.requestBody ?? '—' },
      { label: '响应体', value: row.responseBody ?? '—' },
      { label: '错误', value: row.error ?? '—' },
    ];
  });

  const {
    rows,
    total,
    page,
    loading,
    errorMsg,
    load,
    search: handleSearch,
    goPage: handlePage,
  } = usePagedList<ApiLogItem>({
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

  onMounted(() => void load());

  return {
    PAGE_SIZE,
    METHOD_OPTIONS,
    STATUS_OPTIONS,
    columns,
    keyword,
    method,
    statusKind,
    page,
    rows,
    total,
    loading,
    errorMsg,
    detail,
    detailFields,
    statusKindOf,
    handleSearch,
    handlePage,
  };
}
