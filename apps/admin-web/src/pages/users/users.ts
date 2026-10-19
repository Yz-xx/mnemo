import type { AdminUser, RoleOption, UserRole, UserStatus } from '@/api/types';
import { computed, onMounted, reactive, ref } from 'vue';
import { listUsers, updateUser } from '@/api';
import { usePagedList } from '@/composables/usePagedList';
import { useAuthStore } from '@/stores/auth';
import { useUsersDialog } from './useUsersDialog';
import { useUsersSelection } from './useUsersSelection';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const ROLE_LABEL: Record<UserRole, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  user: '普通用户',
};

/** 角色选项全集：普通用户在前，作为新建账号的默认值 */
const ALL_ROLES: UserRole[] = ['user', 'admin', 'super_admin'];
/** 普通管理员只能授予客户端角色：与后端 routes/admin/users.ts 的 assignableRoles 同口径 */
const CLIENT_ROLES: UserRole[] = ['user'];

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
 * 出口按关注点收敛成 filter / table / selection / dialog / cells 五组，模板按组取用。
 */
export function useUsersPage() {
  const auth = useAuthStore();

  const keyword = ref('');
  /** 当前账号是否超管：只有它能看见并操作后台账号（见 docs/adr/0006） */
  const isSuperAdmin = computed(() => auth.user?.role === 'super_admin');
  /** 行内角色下拉与新建弹窗的可选项：标签一并给出，避免两处各写一份 role→中文 映射 */
  const roleOptions = computed<RoleOption[]>(() =>
    (isSuperAdmin.value ? ALL_ROLES : CLIENT_ROLES).map((value) => ({
      value,
      label: ROLE_LABEL[value],
    })),
  );

  // 勾选随列表内容失效：selection 建在 paged 之后（它要用 paged 的变更出口），
  // 故先用占位函数间接引用，建好后再指向真正的 clearSelection
  let onRowsReload = (): void => {};
  const { rows, total, loading, errorMsg, paging } = usePagedList<AdminUser>({
    pageSize: PAGE_SIZE,
    fetcher: ({ page, pageSize }) => listUsers({ keyword: keyword.value.trim(), page, pageSize }),
    errorFallback: '加载用户列表失败',
    onReset: () => onRowsReload(),
  });

  /** 行内变更进行中：锁住所有操作，避免并发请求把列表刷成中间态 */
  const mutating = ref(false);

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
      await paging.load();
    }
  }

  const selection = useUsersSelection({ mutate });
  onRowsReload = selection.clearSelection;

  const dialog = useUsersDialog({
    search: paging.search,
    reload: paging.load,
    errorMsg,
    selectedIds: selection.selectedIds,
  });

  /** 当前登录账号所在行：自锁规则下这些按钮对它禁用 */
  function isSelf(row: AdminUser): boolean {
    return auth.user?.id === row.id;
  }

  function changeRole(row: AdminUser, event: Event): void {
    const role = (event.target as HTMLSelectElement).value as UserRole;
    void mutate(() => updateUser(row.id, { role }), '变更角色失败');
  }

  function toggleStatus(row: AdminUser): void {
    const status: UserStatus = row.status === 'active' ? 'banned' : 'active';
    void mutate(() => updateUser(row.id, { status }), '变更状态失败');
  }

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
      batchStatus: selection.batchStatus,
      openBatchDelete: dialog.openBatchDelete,
      mutating,
    }),
    dialog: reactive({
      kind: dialog.dialog,
      selected: dialog.selected,
      submitting: dialog.submitting,
      formError: dialog.formError,
      openCreate: dialog.openCreate,
      askDelete: dialog.askDelete,
      closeDialog: dialog.closeDialog,
      handleCreate: dialog.handleCreate,
      confirmDelete: dialog.confirmDelete,
      confirmBatchDelete: dialog.confirmBatchDelete,
    }),
    cells: reactive({
      isSuperAdmin,
      roleOptions,
      ROLE_LABEL,
      STATUS_LABEL,
      isSelf,
      changeRole,
      toggleStatus,
    }),
  };
}
