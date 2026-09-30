// 操作审计：管理端的每一次写操作都由服务端自动登记，本页只做检索与详情查看。
// 与「API 日志」的分工是范围——这里只留写入动作及其操作人，回溯变更时不必在 GET 里翻找。
import type { AuditLogItem } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import { formatTime } from '@repo/shared';
import { listAuditLogs } from '@/api';
import { usePagedList } from '@/composables/usePagedList';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const columns = [
  { key: 'createdAt', label: '时间', width: '170px' },
  { key: 'actor', label: '操作人', width: '140px' },
  { key: 'method', label: '方法', width: '84px' },
  { key: 'path', label: '操作路径' },
  { key: 'status', label: '结果', width: '80px' },
  { key: 'actions', label: '详情', width: '70px', align: 'right' as const },
];

/** 审计页对模板暴露的全部绑定：静态常量在模块顶层，随实例变化的状态与动作在这里组装 */
export function useAuditPage() {
  const keyword = ref('');

  /** 状态色调：2xx 成功、4xx 客户端错误、5xx 服务端错误 */
  function statusKindOf(status: number): 'ok' | 'client' | 'server' {
    if (status >= 500) return 'server';
    if (status >= 400) return 'client';
    return 'ok';
  }

  /** 操作人展示：超级令牌入口无账号 ID，账号被删后也只剩 ID */
  function actorLabel(row: AuditLogItem): string {
    if (row.actorId === null) return '超级令牌';
    return row.actorName ?? `#${row.actorId}`;
  }

  /** 详情弹窗中的这一条：为空表示未打开 */
  const detail = ref<AuditLogItem | null>(null);

  /** 详情字段：值可能为空，统一用「—」占位，避免弹窗出现空白行 */
  const detailFields = computed(() => {
    const row = detail.value;
    if (!row) return [];
    return [
      { label: '操作人', value: actorLabel(row) },
      { label: '操作', value: `${row.method} ${row.path}` },
      { label: '结果', value: String(row.status) },
      { label: '时间', value: formatTime(row.createdAt) },
      { label: '请求体', value: row.detail ?? '—' },
    ];
  });

  /** 分页取数、页码、加载态与错误文案统一交由 usePagedList 托管，本页只提供筛选条件 */
  const {
    rows,
    total,
    page,
    loading,
    errorMsg,
    load,
    search: handleSearch,
    goPage: handlePage,
  } = usePagedList<AuditLogItem>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) =>
      listAuditLogs({ keyword: keyword.value.trim(), page, pageSize }),
    errorFallback: '加载操作审计失败',
  });

  onMounted(() => void load());

  return {
    PAGE_SIZE,
    columns,
    keyword,
    detail,
    detailFields,
    statusKindOf,
    actorLabel,
    rows,
    total,
    page,
    loading,
    errorMsg,
    handleSearch,
    handlePage,
  };
}
