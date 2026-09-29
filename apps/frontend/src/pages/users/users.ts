import type { AdminUser, UserRole, UserStatus } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import {
  batchDeleteUsers,
  batchUpdateUserStatus,
  createUser,
  deleteUser,
  listUsers,
  updateUser,
} from '@/api/admin';
import { usePagedList } from '@/composables/usePagedList';
import { useAuthStore } from '@/stores/auth';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const ROLE_LABEL: Record<UserRole, string> = { admin: '管理员', user: '普通用户' };
const STATUS_LABEL: Record<UserStatus, string> = { active: '正常', banned: '已停用' };

const columns = [
  { key: 'id', label: 'ID', width: '64px' },
  { key: 'username', label: '用户名' },
  { key: 'role', label: '角色', width: '120px' },
  { key: 'status', label: '状态', width: '90px' },
  { key: 'createdAt', label: '创建时间', width: '170px' },
  { key: 'actions', label: '操作', width: '120px', align: 'right' as const },
];

/**
 * 用户管理：搜索 + 分页列表 + 行内改角色 / 状态 + 新建、单条与批量删除。
 * “不能动自己、不能清空管理员”这两条自锁规则由服务端判定（批量时按整批一次算），
 * 前端只做按钮禁用与错误回显，避免两端各写一套规则后互相打架。
 */
export function useUsersPage() {
  const auth = useAuthStore();

  const keyword = ref('');

  /** 已勾选行的键：翻页、搜索或重新取数后由 load 清空，不做跨页保留 */
  const selectedKeys = ref<Array<string | number>>([]);
  /** 批量接口要的账号 ID：行键本就是 id，这里统一收窄为 number */
  const selectedIds = computed(() => selectedKeys.value.map(Number));

  const {
    rows,
    total,
    page,
    loading,
    errorMsg,
    load,
    search: handleSearch,
    goPage: handlePage,
  } = usePagedList<AdminUser>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) => listUsers({ keyword: keyword.value.trim(), page, pageSize }),
    errorFallback: '加载用户列表失败',
    // 选择随列表内容失效：翻页、搜索、重新取数后都不保留已勾选项
    onReset: () => {
      selectedKeys.value = [];
    },
  });

  /** 当前弹窗：同一时刻只可能开一个 */
  const dialog = ref<'create' | 'delete' | 'batch-delete' | null>(null);
  const selected = ref<AdminUser | null>(null);
  const submitting = ref(false);
  const formError = ref('');

  /** 行内变更进行中：锁住所有操作，避免并发请求把列表刷成中间态 */
  const mutating = ref(false);

  /** 当前登录账号所在行：自锁规则下这些按钮对它禁用 */
  function isSelf(row: AdminUser): boolean {
    return auth.user?.id === row.id;
  }

  /** 行内变更的统一出口：无论成败都回读一次，保证控件显示与后端一致 */
  async function mutate(action: () => Promise<unknown>, fallback: string): Promise<void> {
    mutating.value = true;
    errorMsg.value = '';
    try {
      await action();
    } catch (e) {
      errorMsg.value = (e as Error).message || fallback;
    } finally {
      mutating.value = false;
      await load();
    }
  }

  function changeRole(row: AdminUser, event: Event): void {
    const role = (event.target as HTMLSelectElement).value as UserRole;
    void mutate(() => updateUser(row.id, { role }), '变更角色失败');
  }

  function toggleStatus(row: AdminUser): void {
    const status: UserStatus = row.status === 'active' ? 'banned' : 'active';
    void mutate(() => updateUser(row.id, { status }), '变更状态失败');
  }

  function clearSelection(): void {
    selectedKeys.value = [];
  }

  /** 批量停用 / 启用：可逆操作不弹确认，整批规则由服务端判定 */
  function batchStatus(status: UserStatus): void {
    void mutate(() => batchUpdateUserStatus(selectedIds.value, status), '批量变更状态失败');
  }

  function openCreate(): void {
    formError.value = '';
    dialog.value = 'create';
  }

  function askDelete(row: AdminUser): void {
    selected.value = row;
    dialog.value = 'delete';
  }

  function openBatchDelete(): void {
    dialog.value = 'batch-delete';
  }

  function closeDialog(): void {
    dialog.value = null;
    selected.value = null;
  }

  async function handleCreate(input: {
    username: string;
    password: string;
    role: UserRole;
  }): Promise<void> {
    submitting.value = true;
    formError.value = '';
    try {
      await createUser(input);
      closeDialog();
      page.value = 1;
      await load();
    } catch (e) {
      // 保留弹窗与已填内容：用户名被占用这类错误改一个字段就能重试
      formError.value = (e as Error).message || '创建用户失败';
    } finally {
      submitting.value = false;
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = selected.value;
    if (!target) return;
    submitting.value = true;
    try {
      await deleteUser(target.id);
      closeDialog();
      await load();
    } catch (e) {
      errorMsg.value = (e as Error).message || '删除用户失败';
      closeDialog();
    } finally {
      submitting.value = false;
    }
  }

  async function confirmBatchDelete(): Promise<void> {
    submitting.value = true;
    try {
      await batchDeleteUsers(selectedIds.value);
      closeDialog();
      await load();
    } catch (e) {
      errorMsg.value = (e as Error).message || '批量删除用户失败';
      closeDialog();
    } finally {
      submitting.value = false;
    }
  }

  onMounted(() => void load());

  return {
    PAGE_SIZE,
    ROLE_LABEL,
    STATUS_LABEL,
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
    mutating,
    selectedKeys,
    isSelf,
    handleSearch,
    handlePage,
    changeRole,
    toggleStatus,
    clearSelection,
    batchStatus,
    openCreate,
    askDelete,
    openBatchDelete,
    closeDialog,
    handleCreate,
    confirmDelete,
    confirmBatchDelete,
  };
}
