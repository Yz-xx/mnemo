import type { AdminFileItem } from '@/api/types';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { batchDeleteAdminFiles, deleteAdminFile } from '@/api';

interface FilesDeleteDeps {
  /** 原地回读当前页：删除后分页位置保持不动 */
  reload: () => Promise<void>;
  /** 失败原因回落到列表上方的错误条 */
  errorMsg: Ref<string>;
  /** 批量删除要的文件 ID */
  selectedIds: Ref<string[]>;
}

export interface FilesDeleteControls {
  pendingDelete: Ref<AdminFileItem | null>;
  confirmingBatch: Ref<boolean>;
  submitting: Ref<boolean>;
  askDelete: (row: AdminFileItem) => void;
  openBatchDelete: () => void;
  closeDialog: () => void;
  confirmDelete: () => Promise<void>;
  confirmBatchDelete: () => Promise<void>;
}

/**
 * 单条 / 批量删除两个确认弹窗的状态与提交：共用一把提交锁。
 * 列表回读与错误回显经参数注入，本 hook 不反向依赖页面入口。
 */
export function useFilesDelete({
  reload,
  errorMsg,
  selectedIds,
}: FilesDeleteDeps): FilesDeleteControls {
  const pendingDelete = ref<AdminFileItem | null>(null);
  const confirmingBatch = ref(false);
  const submitting = ref(false);

  function askDelete(row: AdminFileItem): void {
    pendingDelete.value = row;
  }

  function openBatchDelete(): void {
    confirmingBatch.value = true;
  }

  /** 关掉弹窗：两个弹窗同一时刻最多开一个，一并清掉省得残留状态 */
  function closeDialog(): void {
    pendingDelete.value = null;
    confirmingBatch.value = false;
  }

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete.value;
    if (!target) return;
    submitting.value = true;
    try {
      await deleteAdminFile(target.id);
      pendingDelete.value = null;
      await reload();
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
      await reload();
    } catch (e) {
      errorMsg.value = (e as Error).message || '批量删除文件失败';
      confirmingBatch.value = false;
    } finally {
      submitting.value = false;
    }
  }

  return {
    pendingDelete,
    confirmingBatch,
    submitting,
    askDelete,
    openBatchDelete,
    closeDialog,
    confirmDelete,
    confirmBatchDelete,
  };
}
