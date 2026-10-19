import type { AdminKnowledgeContent, AdminKnowledgeDocument } from '@/api/types';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { fetchKnowledgeContent, updateKnowledgeDocument } from '@/api';

interface KnowledgeViewDeps {
  /** 当前查看的文档：kind 归 useKnowledgeDialog，这里只借它读写「查看的是哪一篇」 */
  selected: Ref<AdminKnowledgeDocument | null>;
  /** 内容拉取成功后打开查看弹窗（切 kind）：kind 不归本 hook，避免两个子 hook 互相 import */
  openViewDialog: () => void;
  /** 保存成功后原地回读当前页：保证列表行的标题与片段数跟着变 */
  reload: () => Promise<void>;
  /** 失败原因回落到列表上方的错误条 */
  errorMsg: Ref<string>;
}

export interface KnowledgeViewControls {
  viewContent: Ref<AdminKnowledgeContent | null>;
  viewEditing: Ref<boolean>;
  viewSaving: Ref<boolean>;
  viewError: Ref<string>;
  resetView: () => void;
  openView: (row: AdminKnowledgeDocument) => Promise<void>;
  startEdit: () => void;
  handleUpdateDocument: (input: { title: string; content: string }) => Promise<void>;
}

/**
 * 文档内容查看与编辑：弹窗组件保持纯展示，内容与编辑态由本 hook 托管，保存成功后回灌新内容。
 * 开窗动作与已选文档经参数注入，本 hook 不反向依赖页面入口或弹窗 hook。
 */
export function useKnowledgeView({
  selected,
  openViewDialog,
  reload,
  errorMsg,
}: KnowledgeViewDeps): KnowledgeViewControls {
  const viewContent = ref<AdminKnowledgeContent | null>(null);
  const viewEditing = ref(false);
  const viewSaving = ref(false);
  const viewError = ref('');

  /** 关闭弹窗时复位查看态：清空内容、编辑态与错误，回到只读的初始状态 */
  function resetView(): void {
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
      openViewDialog();
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
      await reload();
    } catch (e) {
      // 保留编辑态与已填内容，便于排查后直接重试
      viewError.value = (e as Error).message || '保存文档失败';
    } finally {
      viewSaving.value = false;
    }
  }

  return {
    viewContent,
    viewEditing,
    viewSaving,
    viewError,
    resetView,
    openView,
    startEdit,
    handleUpdateDocument,
  };
}
