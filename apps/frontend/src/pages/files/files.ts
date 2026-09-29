// 文件管理：管理视角列出全部用户的上传文件，可清理。
// 列表只展示元数据（文件名、类型、大小、归属），文件字节留在服务端，不在此页预览。
import type { AdminFileItem } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import { batchDeleteAdminFiles, deleteAdminFile, listAdminFiles } from '@/api/admin';
import { usePagedList } from '@/composables/usePagedList';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

/** 字节单位的进位基数：按 1024 递进，与系统文件管理器一致 */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

const columns = [
  { key: 'name', label: '文件名' },
  { key: 'ext', label: '类型', width: '80px' },
  { key: 'size', label: '大小', width: '100px', align: 'right' as const },
  { key: 'owner', label: '归属', width: '140px' },
  { key: 'createdAt', label: '上传时间', width: '170px' },
  { key: 'actions', label: '操作', width: '80px', align: 'right' as const },
];

/** 文件管理页的全部状态与动作：模板只做展示，逻辑集中在此以便单独复用与测试 */
export function useFilesPage() {
  const keyword = ref('');

  const pendingDelete = ref<AdminFileItem | null>(null);
  const confirmingBatch = ref(false);
  const submitting = ref(false);

  /** 已勾选行的键：翻页、搜索或重新取数后由 load 清空，不做跨页保留 */
  const selectedKeys = ref<Array<string | number>>([]);
  /** 批量接口要的文件 ID：行键本身就是字符串 ID */
  const selectedIds = computed(() => selectedKeys.value.map(String));

  /** 人类可读的文件大小：超过 1GB 只到 GB，避免列表出现长串数字 */
  function formatSize(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
      value /= 1024;
      unit += 1;
    }
    // 字节数不显示小数位，其余保留一位
    return `${unit === 0 ? value : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
  }

  const {
    rows,
    total,
    page,
    loading,
    errorMsg,
    load,
    search: handleSearch,
    goPage: handlePage,
  } = usePagedList<AdminFileItem>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) =>
      listAdminFiles({ keyword: keyword.value.trim(), page, pageSize }),
    errorFallback: '加载文件列表失败',
    // 选择随列表内容失效：翻页、搜索、重新取数后都不保留已勾选项
    onReset: () => {
      selectedKeys.value = [];
    },
  });

  function clearSelection(): void {
    selectedKeys.value = [];
  }

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete.value;
    if (!target) return;
    submitting.value = true;
    try {
      await deleteAdminFile(target.id);
      pendingDelete.value = null;
      await load();
    } catch (e) {
      errorMsg.value = (e as Error).message || '删除文件失败';
      pendingDelete.value = null;
    } finally {
      submitting.value = false;
    }
  }

  async function confirmBatchDelete(): Promise<void> {
    submitting.value = true;
    try {
      await batchDeleteAdminFiles(selectedIds.value);
      confirmingBatch.value = false;
      await load();
    } catch (e) {
      errorMsg.value = (e as Error).message || '批量删除文件失败';
      confirmingBatch.value = false;
    } finally {
      submitting.value = false;
    }
  }

  onMounted(() => void load());

  return {
    PAGE_SIZE,
    columns,
    keyword,
    page,
    rows,
    total,
    loading,
    errorMsg,
    pendingDelete,
    confirmingBatch,
    submitting,
    selectedKeys,
    formatSize,
    handleSearch,
    handlePage,
    clearSelection,
    confirmDelete,
    confirmBatchDelete,
  };
}
