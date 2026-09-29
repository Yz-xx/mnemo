// 会话管理：管理视角列出全部用户的会话，可查看消息内容、删除整条会话或批量删除。
// 用户的私有会话在这里同样可见——后台需要能核查内容并清理。
import type { AdminConversationDetail, AdminConversationSummary, MessageRole } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import {
  batchDeleteAdminConversations,
  deleteAdminConversation,
  fetchAdminConversation,
  listAdminConversations,
} from '@/api/admin';
import { usePagedList } from '@/composables/usePagedList';

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

/** 会话管理页对模板暴露的全部绑定：静态常量在模块顶层，随实例变化的状态与动作在这里组装 */
export function useConversationsPage() {
  const keyword = ref('');

  /** 详情弹窗：先开窗再取内容，避免点击后界面无反馈 */
  const detail = ref<AdminConversationDetail | null>(null);
  const detailLoading = ref(false);

  const pendingDelete = ref<AdminConversationSummary | null>(null);
  const confirmingBatch = ref(false);
  const submitting = ref(false);

  /** 已勾选行的键：翻页、搜索或重新取数后由 load 清空，不做跨页保留 */
  const selectedKeys = ref<Array<string | number>>([]);
  /** 批量接口要的会话 ID：行键本身就是字符串 ID */
  const selectedIds = computed(() => selectedKeys.value.map(String));

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
  } = usePagedList<AdminConversationSummary>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) =>
      listAdminConversations({ keyword: keyword.value.trim(), page, pageSize }),
    errorFallback: '加载会话列表失败',
    // 选择随列表内容失效：翻页、搜索、重新取数后都不保留已勾选项
    onReset: () => {
      selectedKeys.value = [];
    },
  });

  function clearSelection(): void {
    selectedKeys.value = [];
  }

  /** 关闭详情：两个状态必须一并复位，否则「加载中关闭」时弹窗仍挂在 v-if 上 */
  function closeDetail(): void {
    detailLoading.value = false;
    detail.value = null;
  }

  async function openDetail(row: AdminConversationSummary): Promise<void> {
    detailLoading.value = true;
    detail.value = null;
    errorMsg.value = '';
    try {
      const result = await fetchAdminConversation(row.id);
      // 请求返回前用户可能已关闭弹窗：此时不再写回，否则弹窗会自己弹回来
      if (detailLoading.value) detail.value = result;
    } catch (e) {
      errorMsg.value = (e as Error).message || '加载会话详情失败';
    } finally {
      detailLoading.value = false;
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete.value;
    if (!target) return;
    submitting.value = true;
    try {
      await deleteAdminConversation(target.id);
      pendingDelete.value = null;
      await load();
    } catch (e) {
      errorMsg.value = (e as Error).message || '删除会话失败';
      pendingDelete.value = null;
    } finally {
      submitting.value = false;
    }
  }

  async function confirmBatchDelete(): Promise<void> {
    submitting.value = true;
    try {
      await batchDeleteAdminConversations(selectedIds.value);
      confirmingBatch.value = false;
      await load();
    } catch (e) {
      errorMsg.value = (e as Error).message || '批量删除会话失败';
      confirmingBatch.value = false;
    } finally {
      submitting.value = false;
    }
  }

  onMounted(() => void load());

  return {
    PAGE_SIZE,
    columns,
    ROLE_LABEL,
    keyword,
    detail,
    detailLoading,
    pendingDelete,
    confirmingBatch,
    submitting,
    selectedKeys,
    clearSelection,
    closeDetail,
    openDetail,
    confirmDelete,
    confirmBatchDelete,
    rows,
    total,
    page,
    loading,
    errorMsg,
    handleSearch,
    handlePage,
  };
}
