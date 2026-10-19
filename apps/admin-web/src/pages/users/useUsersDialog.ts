import type { AdminUser, UserRole } from '@/api/types';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { batchDeleteUsers, createUser, deleteUser } from '@/api';

/** 当前弹窗：同一时刻只可能开一个 */
export type UsersDialogKind = 'create' | 'delete' | 'batch-delete';

interface UsersDialogDeps {
  /** 回到第一页再取数：新建成功后要能立刻看到新账号 */
  search: () => Promise<void>;
  /** 原地回读当前页：删除后分页位置保持不动 */
  reload: () => Promise<void>;
  /** 失败原因回落到列表上方的错误条 */
  errorMsg: Ref<string>;
  /** 批量删除要的账号 ID */
  selectedIds: Ref<number[]>;
}

export interface UsersDialogControls {
  dialog: Ref<UsersDialogKind | null>;
  selected: Ref<AdminUser | null>;
  submitting: Ref<boolean>;
  formError: Ref<string>;
  openCreate: () => void;
  askDelete: (row: AdminUser) => void;
  openBatchDelete: () => void;
  closeDialog: () => void;
  handleCreate: (input: { username: string; password: string; role: UserRole }) => Promise<void>;
  confirmDelete: () => Promise<void>;
  confirmBatchDelete: () => Promise<void>;
}

/**
 * 新建 / 单条删除 / 批量删除三个弹窗的状态与提交：共用一把提交锁与一个表单错误位。
 * 列表的取数与错误回显经参数注入，本 hook 不反向依赖页面入口。
 */
export function useUsersDialog({
  search,
  reload,
  errorMsg,
  selectedIds,
}: UsersDialogDeps): UsersDialogControls {
  const dialog = ref<UsersDialogKind | null>(null);
  const selected = ref<AdminUser | null>(null);
  const submitting = ref(false);
  const formError = ref('');

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
      await search();
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
      await reload();
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
      await reload();
    } catch (e) {
      errorMsg.value = (e as Error).message || '批量删除用户失败';
      closeDialog();
    } finally {
      submitting.value = false;
    }
  }

  return {
    dialog,
    selected,
    submitting,
    formError,
    openCreate,
    askDelete,
    openBatchDelete,
    closeDialog,
    handleCreate,
    confirmDelete,
    confirmBatchDelete,
  };
}
