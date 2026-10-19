// 文件管理：管理视角列出全部用户的上传文件，可清理。
// 列表只展示元数据（文件名、类型、大小、归属），文件字节留在服务端，不在此页预览。
import type { AdminFileItem } from '@/api/types';
import { onMounted, reactive, ref } from 'vue';
import { formatBytes } from '@repo/shared';
import { listAdminFiles } from '@/api';
import { usePagedList } from '@/composables/usePagedList';
import { useFilesDelete } from './useFilesDelete';
import { useFilesSelection } from './useFilesSelection';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const columns = [
  { key: 'name', label: '文件名' },
  { key: 'ext', label: '类型', width: '80px' },
  { key: 'size', label: '大小', width: '100px', align: 'right' as const },
  { key: 'owner', label: '归属', width: '140px' },
  { key: 'createdAt', label: '上传时间', width: '170px' },
  { key: 'actions', label: '操作', width: '80px', align: 'right' as const },
];

/**
 * 文件管理页的入口：按关注点收成 filter / table / selection / dialog / cells 五组，模板按组取用。
 * 勾选与删除确认各自进子 hook，本入口只负责建状态并注入回调（子 hook 间不互相依赖）。
 */
export function useFilesPage() {
  const keyword = ref('');

  // 勾选先建：paged 的 onReset 要用它的清空出口，故必须先于 usePagedList 存在
  const selection = useFilesSelection();

  const { rows, total, loading, errorMsg, paging } = usePagedList<AdminFileItem>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) =>
      listAdminFiles({ keyword: keyword.value.trim(), page, pageSize }),
    errorFallback: '加载文件列表失败',
    // 选择随列表内容失效：翻页、搜索、重新取数后都不保留已勾选项
    onReset: () => selection.clearSelection(),
  });

  const dialog = useFilesDelete({
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
      openBatchDelete: dialog.openBatchDelete,
    }),
    dialog: reactive({
      pendingDelete: dialog.pendingDelete,
      confirmingBatch: dialog.confirmingBatch,
      submitting: dialog.submitting,
      askDelete: dialog.askDelete,
      closeDialog: dialog.closeDialog,
      confirmDelete: dialog.confirmDelete,
      confirmBatchDelete: dialog.confirmBatchDelete,
    }),
    cells: reactive({ formatBytes }),
  };
}
