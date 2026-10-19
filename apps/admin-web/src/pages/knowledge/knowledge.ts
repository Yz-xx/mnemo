import type { KnowledgeDialogKind } from './useKnowledgeDialog';
import type { AdminKnowledgeDocument, KnowledgeScope } from '@/api/types';
import { onMounted, reactive, ref } from 'vue';
import { listKnowledgeDocuments } from '@/api';
import { usePagedList } from '@/composables/usePagedList';
import { useKnowledgeDialog } from './useKnowledgeDialog';
import { useKnowledgeSelection } from './useKnowledgeSelection';
import { useKnowledgeView } from './useKnowledgeView';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const SCOPE_LABEL: Record<KnowledgeScope, string> = { global: '全局', private: '私有' };

const columns = [
  { key: 'title', label: '标题' },
  { key: 'scope', label: '范围', width: '90px' },
  { key: 'owner', label: '归属', width: '140px' },
  { key: 'chunks', label: '片段', width: '80px', align: 'right' as const },
  { key: 'createdAt', label: '入库时间', width: '170px' },
  { key: 'actions', label: '操作', width: '120px', align: 'right' as const },
];

/**
 * 知识库管理：管理视角的文档列表（含各用户的私有文档）+ 新增全局文档 + 单条与批量删除 + 内容查看与编辑。
 * 文档存在向量库而非关系表，后端在内存里过滤与分页，前端按同一套翻页交互处理。
 * 出口按关注点收敛成 filter / table / selection / dialog / view 五组，模板按组取用。
 */
export function useKnowledgePage() {
  const keyword = ref('');

  // 勾选随列表内容失效，故 selection 先建，好让 usePagedList 的 onReset 直接引用它的清空动作
  const selection = useKnowledgeSelection();

  const { rows, total, loading, errorMsg, paging } = usePagedList<AdminKnowledgeDocument>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) =>
      listKnowledgeDocuments({ keyword: keyword.value.trim(), page, pageSize }),
    errorFallback: '加载文档列表失败',
    // 选择随列表内容失效：翻页、搜索、重新取数后都不保留已勾选项
    onReset: () => selection.clearSelection(),
  });

  // 弹窗 kind 与已选文档是两个子 hook 共用的状态：由入口创建后注入，子 hook 之间不互相 import
  const dialogKind = ref<KnowledgeDialogKind | null>(null);
  const selected = ref<AdminKnowledgeDocument | null>(null);

  // 查看 hook 先建：它只操作注入的已选文档 ref，开窗（切 kind）经回调交回入口
  const view = useKnowledgeView({
    selected,
    openViewDialog: () => {
      dialogKind.value = 'view';
    },
    reload: paging.load,
    errorMsg,
  });

  /** 关闭任一弹窗：收掉共享的 kind 与已选文档，再复位查看态 */
  function closeDialog(): void {
    dialogKind.value = null;
    selected.value = null;
    view.resetView();
  }

  const dialog = useKnowledgeDialog({
    dialog: dialogKind,
    selected,
    closeDialog,
    search: paging.search,
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
      SCOPE_LABEL,
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
      kind: dialogKind,
      selected,
      submitting: dialog.submitting,
      formError: dialog.formError,
      openCreate: dialog.openCreate,
      askDelete: dialog.askDelete,
      closeDialog,
      handleCreate: dialog.handleCreate,
      confirmDelete: dialog.confirmDelete,
      confirmBatchDelete: dialog.confirmBatchDelete,
    }),
    view: reactive({
      content: view.viewContent,
      editing: view.viewEditing,
      saving: view.viewSaving,
      error: view.viewError,
      open: view.openView,
      startEdit: view.startEdit,
      update: view.handleUpdateDocument,
    }),
  };
}
