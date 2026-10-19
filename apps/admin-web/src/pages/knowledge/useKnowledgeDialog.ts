import type { AdminKnowledgeDocument } from '@/api/types';
import type { Ref } from 'vue';
import { ref } from 'vue';
import {
  batchDeleteKnowledgeDocuments,
  createGlobalDocument,
  deleteKnowledgeDocument,
} from '@/api';

/** 当前弹窗：同一时刻只可能开一个 */
export type KnowledgeDialogKind = 'create' | 'delete' | 'batch-delete' | 'view';

interface KnowledgeDialogDeps {
  /** 弹窗 kind 与已选文档：由入口创建后注入，与查看 hook 共用同一份状态 */
  dialog: Ref<KnowledgeDialogKind | null>;
  selected: Ref<AdminKnowledgeDocument | null>;
  /** 关闭动作由入口统一实现：它还要顺带复位查看 hook 的状态 */
  closeDialog: () => void;
  /** 回到第一页再取数：新建成功后要能立刻看到新文档 */
  search: () => Promise<void>;
  /** 原地回读当前页：删除后分页位置保持不动 */
  reload: () => Promise<void>;
  /** 失败原因回落到列表上方的错误条 */
  errorMsg: Ref<string>;
  /** 批量删除要的文档 ID */
  selectedIds: Ref<string[]>;
}

export interface KnowledgeDialogControls {
  submitting: Ref<boolean>;
  formError: Ref<string>;
  openCreate: () => void;
  askDelete: (row: AdminKnowledgeDocument) => void;
  openBatchDelete: () => void;
  handleCreate: (input: { title: string; content: string }) => Promise<void>;
  confirmDelete: () => Promise<void>;
  confirmBatchDelete: () => Promise<void>;
}

/**
 * 新建 / 单条删除 / 批量删除三个弹窗的状态与提交：共用一把提交锁与一个表单错误位。
 * 弹窗 kind 与已选文档由入口创建后注入（查看弹窗读同一份），列表取数与错误回显同样经参数注入，
 * 本 hook 不反向依赖页面入口或查看 hook；查看弹窗的开窗动作归 useKnowledgeView。
 */
export function useKnowledgeDialog({
  dialog,
  selected,
  closeDialog,
  search,
  reload,
  errorMsg,
  selectedIds,
}: KnowledgeDialogDeps): KnowledgeDialogControls {
  const submitting = ref(false);
  const formError = ref('');

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

  async function handleCreate(input: { title: string; content: string }): Promise<void> {
    submitting.value = true;
    formError.value = '';
    try {
      await createGlobalDocument(input);
      closeDialog();
      await search();
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
      await reload();
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
      await reload();
    } catch (e) {
      errorMsg.value = (e as Error).message || '批量删除文档失败';
      closeDialog();
    } finally {
      submitting.value = false;
    }
  }

  return {
    submitting,
    formError,
    openCreate,
    askDelete,
    openBatchDelete,
    handleCreate,
    confirmDelete,
    confirmBatchDelete,
  };
}
