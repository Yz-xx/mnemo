import type { KnowledgeDialogKind } from './useKnowledgeDialog';
import type { AdminKnowledgeBase, AdminKnowledgeDocument } from '@/api/types';
import { computed, onMounted, reactive, ref } from 'vue';
import { deleteKnowledgeBase, listKnowledgeBases, listKnowledgeDocuments } from '@/api';
import { DEFAULT_PAGE_SIZE, usePagedList } from '@/composables/usePagedList';
import { useStringTableSelection } from '@/composables/useTableSelection';
import { useKnowledgeDialog } from './useKnowledgeDialog';
import { useKnowledgeView } from './useKnowledgeView';

const columns = [
  { key: 'title', label: '标题' },
  { key: 'knowledgeBase', label: '知识库', width: '180px' },
  { key: 'owner', label: '归属', width: '140px' },
  { key: 'chunks', label: '片段', width: '80px', align: 'right' as const },
  { key: 'createdAt', label: '入库时间', width: '170px' },
  { key: 'actions', label: '操作', width: '120px', align: 'right' as const },
];

/**
 * 知识库管理：管理视角的文档列表（含各用户的私有文档）+ 新增共享库文档 + 单条与批量删除 + 内容查看与编辑。
 * 文档行只带所属库 ID，库名由库列表一次取回后在本地映射展示。
 * 出口按关注点收敛成 filter / table / selection / dialog / view 五组，模板按组取用。
 */
export function useKnowledgePage() {
  const keyword = ref('');

  // 文档行只带库 ID：库名一次取回后本地映射，避免逐行再查
  const bases = ref<AdminKnowledgeBase[]>([]);
  const baseNames = computed(() => new Map(bases.value.map((base) => [base.id, base.name])));
  const baseName = (id: string): string => baseNames.value.get(id) ?? id;

  // 勾选随列表内容失效，故 selection 先建，好让 usePagedList 的 onReset 直接引用它的清空动作
  const selection = useStringTableSelection();

  const { rows, total, loading, errorMsg, paging } = usePagedList<AdminKnowledgeDocument>({
    pageSize: DEFAULT_PAGE_SIZE,
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

  /** 库名解析失败不阻塞文档列表：列表回退展示库 ID */
  async function loadBases(): Promise<void> {
    try {
      bases.value = await listKnowledgeBases();
    } catch (e) {
      errorMsg.value = (e as Error).message || '加载知识库列表失败';
    }
  }

  // 整库删除单独确认：删除会级联清空库内文档，成功后文档表必须重取
  const baseToDelete = ref<AdminKnowledgeBase | null>(null);
  const baseDeleting = ref(false);

  function askDeleteBase(base: AdminKnowledgeBase): void {
    baseToDelete.value = base;
  }

  function cancelDeleteBase(): void {
    baseToDelete.value = null;
  }

  async function confirmDeleteBase(): Promise<void> {
    const target = baseToDelete.value;
    if (!target) return;
    baseDeleting.value = true;
    try {
      await deleteKnowledgeBase(target.id);
      baseToDelete.value = null;
      // 当前页可能全是被删库的文档，回到第一页重新取数
      await Promise.all([loadBases(), paging.search()]);
    } catch (e) {
      baseToDelete.value = null;
      errorMsg.value = (e as Error).message || '删除知识库失败';
    } finally {
      baseDeleting.value = false;
    }
  }

  onMounted(() => {
    void loadBases();
    void paging.load();
  });

  // 分组包一层 reactive：嵌套在普通对象里的 ref 在模板中不会被解包，包过 reactive 才会
  return {
    filter: reactive({ keyword, handleSearch: paging.search }),
    table: reactive({
      pageSize: DEFAULT_PAGE_SIZE,
      columns,
      rows,
      page: paging.page,
      total,
      loading,
      errorMsg,
      handlePage: paging.goPage,
      baseName,
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
    bases: reactive({
      list: bases,
      deleteTarget: baseToDelete,
      deleting: baseDeleting,
      askDelete: askDeleteBase,
      cancelDelete: cancelDeleteBase,
      confirmDelete: confirmDeleteBase,
    }),
  };
}
