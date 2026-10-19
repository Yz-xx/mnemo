import type { AdminConversationSummary } from '@/api/types';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { batchDeleteAdminConversations, deleteAdminConversation } from '@/api';

interface ConversationsDialogDeps {
  /** 原地回读当前页：删除后分页位置保持不动 */
  reload: () => Promise<void>;
  /** 失败原因回落到列表上方的错误条 */
  errorMsg: Ref<string>;
  /** 批量删除要的会话 ID */
  selectedIds: Ref<string[]>;
}

export interface ConversationsDialogControls {
  pendingDelete: Ref<AdminConversationSummary | null>;
  confirmingBatch: Ref<boolean>;
  submitting: Ref<boolean>;
  confirmDelete: () => Promise<void>;
  confirmBatchDelete: () => Promise<void>;
}

/**
 * 单条删除与批量删除两个确认弹窗：共用一把提交锁，
 * 列表的取数与错误回显经参数注入，本 hook 不反向依赖页面入口。
 */
export function useConversationsDialog({
  reload,
  errorMsg,
  selectedIds,
}: ConversationsDialogDeps): ConversationsDialogControls {
  /** 待删除的单条会话：有值即代表确认弹窗打开 */
  const pendingDelete = ref<AdminConversationSummary | null>(null);
  const confirmingBatch = ref(false);
  const submitting = ref(false);

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete.value;
    if (!target) return;
    submitting.value = true;
    try {
      await deleteAdminConversation(target.id);
      pendingDelete.value = null;
      await reload();
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
      await reload();
    } catch (e) {
      errorMsg.value = (e as Error).message || '批量删除会话失败';
      confirmingBatch.value = false;
    } finally {
      submitting.value = false;
    }
  }

  return { pendingDelete, confirmingBatch, submitting, confirmDelete, confirmBatchDelete };
}
