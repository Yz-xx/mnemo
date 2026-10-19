// 会话管理：管理视角列出全部用户的会话，可查看消息内容、删除整条会话或批量删除。
// 用户的私有会话在这里同样可见——后台需要能核查内容并清理。
import type { AdminConversationSummary, MessageRole } from '@/api/types';
import { onMounted, reactive, ref } from 'vue';
import { listAdminConversations } from '@/api';
import { usePagedList } from '@/composables/usePagedList';
import { useConversationsDetail } from './useConversationsDetail';
import { useConversationsDialog } from './useConversationsDialog';
import { useConversationsSelection } from './useConversationsSelection';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const ROLE_LABEL: Record<MessageRole, string> = { user: '用户', assistant: '助手', system: '系统' };

const columns = [
  { key: 'title', label: '标题' },
  { key: 'owner', label: '归属', width: '140px' },
  { key: 'messageCount', label: '消息数', width: '90px', align: 'right' as const },
  { key: 'updatedAt', label: '最近更新', width: '170px' },
  { key: 'actions', label: '操作', width: '120px', align: 'right' as const },
];

/**
 * 会话管理：搜索 + 分页列表 + 详情抽屉 + 单条与批量删除。
 * 出口按关注点收敛成 filter / table / selection / detail / dialog 五组，模板按组取用。
 */
export function useConversationsPage() {
  const keyword = ref('');

  // 勾选随列表内容失效：selection 建在 paged 之后（它要用 paged 的变更出口），
  // 故先用占位函数间接引用，建好后再指向真正的 clearSelection
  let onRowsReload = (): void => {};
  /** 分页取数、页码、加载态与错误文案统一交由 usePagedList 托管，本页只提供筛选条件 */
  const { rows, total, loading, errorMsg, paging } = usePagedList<AdminConversationSummary>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) =>
      listAdminConversations({ keyword: keyword.value.trim(), page, pageSize }),
    errorFallback: '加载会话列表失败',
    // 选择随列表内容失效：翻页、搜索、重新取数后都不保留已勾选项
    onReset: () => onRowsReload(),
  });

  const selection = useConversationsSelection();
  onRowsReload = selection.clearSelection;

  const detail = useConversationsDetail({ errorMsg });
  const dialog = useConversationsDialog({
    reload: paging.load,
    errorMsg,
    selectedIds: selection.selectedIds,
  });

  onMounted(() => void paging.load());

  // 分组包一层 reactive：嵌套在普通对象里的 ref 在模板中不会被解包，包过 reactive 才会
  return {
    filter: reactive({ keyword, handleSearch: paging.search }),
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
    selection: reactive({
      selectedKeys: selection.selectedKeys,
      clearSelection: selection.clearSelection,
    }),
    detail: reactive({
      content: detail.detail,
      loading: detail.detailLoading,
      ROLE_LABEL,
      open: detail.openDetail,
      close: detail.closeDetail,
    }),
    dialog: reactive({
      target: dialog.pendingDelete,
      batchOpen: dialog.confirmingBatch,
      submitting: dialog.submitting,
      confirmDelete: dialog.confirmDelete,
      confirmBatch: dialog.confirmBatchDelete,
    }),
  };
}
