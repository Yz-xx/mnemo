import type { AdminKnowledgeContent, AdminKnowledgeDocument, KnowledgeScope } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import {
  batchDeleteKnowledgeDocuments,
  createGlobalDocument,
  deleteKnowledgeDocument,
  fetchKnowledgeContent,
  listKnowledgeDocuments,
  updateKnowledgeDocument,
} from '@/api';
import { usePagedList } from '@/composables/usePagedList';

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
 */
export function useKnowledgePage() {
  const keyword = ref('');

  /** 已勾选行的键：翻页、搜索或重新取数后由 load 清空，不做跨页保留 */
  const selectedKeys = ref<Array<string | number>>([]);
  /** 批量接口要的文档 ID：行键本身就是字符串 ID */
  const selectedIds = computed(() => selectedKeys.value.map(String));

  const {
    rows,
    total,
    page,
    loading,
    errorMsg,
    load,
    search: handleSearch,
    goPage: handlePage,
  } = usePagedList<AdminKnowledgeDocument>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) =>
      listKnowledgeDocuments({ keyword: keyword.value.trim(), page, pageSize }),
    errorFallback: '加载文档列表失败',
    // 选择随列表内容失效：翻页、搜索、重新取数后都不保留已勾选项
    onReset: () => {
      selectedKeys.value = [];
    },
  });

  /** 当前弹窗：同一时刻只可能开一个 */
  const dialog = ref<'create' | 'delete' | 'batch-delete' | 'view' | null>(null);
  const selected = ref<AdminKnowledgeDocument | null>(null);
  const submitting = ref(false);
  const formError = ref('');

  /** 查看弹窗的内容与编辑态由页面托管：弹窗组件保持纯展示，保存成功后父级回灌新内容 */
  const viewContent = ref<AdminKnowledgeContent | null>(null);
  const viewEditing = ref(false);
  const viewSaving = ref(false);
  const viewError = ref('');

  function clearSelection(): void {
    selectedKeys.value = [];
  }

  function openCreate(): void {
    formError.value = '';
    dialog.value = 'create';
  }

  function askDelete(row: AdminKnowledgeDocument): void {
    selected.value = row;
    dialog.value = 'delete';
  }

  function openBatchDelete(): void {
    dialog.value = 'batch-delete';
  }

  function closeDialog(): void {
    dialog.value = null;
    selected.value = null;
    viewContent.value = null;
    viewEditing.value = false;
    viewError.value = '';
  }

  async function openView(row: AdminKnowledgeDocument): Promise<void> {
    try {
      viewContent.value = await fetchKnowledgeContent(row.id);
      viewEditing.value = false;
      viewError.value = '';
      selected.value = row;
      dialog.value = 'view';
    } catch (e) {
      // 拉取失败不开弹窗，错误落在列表顶部的提示区
      errorMsg.value = (e as Error).message || '加载文档内容失败';
    }
  }

  function startEdit(): void {
    viewEditing.value = true;
    viewError.value = '';
  }

  async function handleUpdateDocument(input: { title: string; content: string }): Promise<void> {
    const target = selected.value;
    if (!target) return;
    viewSaving.value = true;
    viewError.value = '';
    try {
      await updateKnowledgeDocument(target.id, input);
      // 保存成功：回灌最新内容（组件 watch 会据此重置表单）并退出编辑态，随后刷新列表行
      viewContent.value = await fetchKnowledgeContent(target.id);
      viewEditing.value = false;
      await load();
    } catch (e) {
      // 保留编辑态与已填内容，便于排查后直接重试
      viewError.value = (e as Error).message || '保存文档失败';
    } finally {
      viewSaving.value = false;
    }
  }

  async function handleCreate(input: { title: string; content: string }): Promise<void> {
    submitting.value = true;
    formError.value = '';
    try {
      await createGlobalDocument(input);
      closeDialog();
      page.value = 1;
      await load();
    } catch (e) {
      // 保留弹窗与已填内容，便于改完环境后直接重试
      formError.value = (e as Error).message || '文档入库失败';
    } finally {
      submitting.value = false;
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = selected.value;
    if (!target) return;
    submitting.value = true;
    try {
      await deleteKnowledgeDocument(target.id);
      closeDialog();
      await load();
    } catch (e) {
      errorMsg.value = (e as Error).message || '删除文档失败';
      closeDialog();
    } finally {
      submitting.value = false;
    }
  }

  async function confirmBatchDelete(): Promise<void> {
    submitting.value = true;
    try {
      await batchDeleteKnowledgeDocuments(selectedIds.value);
      closeDialog();
      await load();
    } catch (e) {
      errorMsg.value = (e as Error).message || '批量删除文档失败';
      closeDialog();
    } finally {
      submitting.value = false;
    }
  }

  onMounted(() => void load());

  return {
    PAGE_SIZE,
    SCOPE_LABEL,
    columns,
    keyword,
    page,
    rows,
    total,
    loading,
    errorMsg,
    dialog,
    selected,
    submitting,
    formError,
    selectedKeys,
    viewContent,
    viewEditing,
    viewSaving,
    viewError,
    handleSearch,
    handlePage,
    clearSelection,
    openCreate,
    askDelete,
    openBatchDelete,
    openView,
    startEdit,
    closeDialog,
    handleCreate,
    confirmDelete,
    confirmBatchDelete,
    handleUpdateDocument,
  };
}
