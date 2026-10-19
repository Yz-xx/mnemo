// 操作审计：管理端的每一次写操作都由服务端自动登记，本页只做检索与详情查看。
// 与「API 日志」的分工是范围——这里只留写入动作及其操作人，回溯变更时不必在 GET 里翻找。
import type { AuditLogItem } from '@/api/types';
import { onMounted, reactive } from 'vue';
import { listAuditLogs } from '@/api';
import { usePagedList } from '@/composables/usePagedList';
import { useAuditDetail } from './useAuditDetail';
import { useAuditFilter } from './useAuditFilter';

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

/**
 * 操作审计页：筛选 + 分页列表 + 详情弹窗。
 * 出口按关注点收敛成 filter / table / detail / cells 四组，模板按组取用。
 */
export function useAuditPage() {
  // 取数动作要读筛选条件，而筛选条件由 filter 持有，故先用占位函数间接引用，
  // paged 建好后再指向真正的 search（同 users 的 onRowsReload 手法）
  let runSearch: () => Promise<void> = () => Promise.resolve();
  const filter = useAuditFilter({ search: () => runSearch() });

  const { rows, total, loading, errorMsg, paging } = usePagedList<AuditLogItem>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) =>
      listAuditLogs({ keyword: filter.keyword.value.trim(), page, pageSize }),
    errorFallback: '加载操作审计失败',
  });
  runSearch = paging.search;

  const detail = useAuditDetail({ actorLabel });

  onMounted(() => void paging.load());

  // 分组包一层 reactive：嵌套在普通对象里的 ref 在模板中不会被解包，包过 reactive 才会
  return {
    filter: reactive({ keyword: filter.keyword, handleSearch: filter.handleSearch }),
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
    detail: reactive({ row: detail.detail, fields: detail.detailFields }),
    cells: reactive({ statusKindOf, actorLabel }),
  };
}
