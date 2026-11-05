import type { AgentApi } from '../../api/client';
import type { KnowledgeBaseView } from '../../types';
import type { Ref } from 'vue';
import { reactive, ref } from 'vue';
import { toErrorMessage } from '../../api/client';

/** 库名称长度上限：与服务端 varchar(128) 同口径，超限在本地就拦下 */
const NAME_MAX_LENGTH = 128;

/** 新建 / 编辑对话框的本地状态 */
export interface KnowledgeEditorState {
  visible: boolean;
  mode: 'create' | 'edit';
  /** 编辑目标的库 ID；新建时为 null */
  id: string | null;
  name: string;
  description: string;
  busy: boolean;
  /** 本地校验或服务端返回的错误：对话框内展示，不写到全局提示位 */
  error: string;
}

interface KnowledgeBasesDeps {
  /** 操作提示位：创建、更新、删除的结果都写这里 */
  notice: Ref<string>;
  /** 地址取抽屉草稿、令牌取当前登录态的实例 */
  api: AgentApi;
}

export interface KnowledgeBasesControls {
  bases: Ref<KnowledgeBaseView[]>;
  loading: Ref<boolean>;
  /** 当前打开的库详情；为空表示停留在库列表视图 */
  activeBase: Ref<KnowledgeBaseView | null>;
  editor: KnowledgeEditorState;
  /** 待确认删除的库：非空即弹出二次确认 */
  deleteTarget: Ref<KnowledgeBaseView | null>;
  loadBases: () => Promise<void>;
  enter: (base: KnowledgeBaseView) => void;
  back: () => Promise<void>;
  openCreate: () => void;
  openEdit: (base: KnowledgeBaseView) => void;
  closeEditor: () => void;
  submitEditor: () => Promise<void>;
  requestDelete: (base: KnowledgeBaseView) => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
}

/**
 * 知识库的增删改查与列表 / 详情切换：库清单、当前库、编辑对话框与删除确认都归此。
 * 文档列表由 `useKnowledgeList` 负责，本 hook 只提供「当前打开哪个库」。
 * 只有私有库可维护：客户端能看到的私有库都是自己的，global 库由管理端维护。
 */
export function useKnowledgeBases({ notice, api }: KnowledgeBasesDeps): KnowledgeBasesControls {
  const bases = ref<KnowledgeBaseView[]>([]);
  const loading = ref(false);
  const activeBase = ref<KnowledgeBaseView | null>(null);
  const deleteTarget = ref<KnowledgeBaseView | null>(null);

  const editor = reactive<KnowledgeEditorState>({
    visible: false,
    mode: 'create',
    id: null,
    name: '',
    description: '',
    busy: false,
    error: '',
  });

  /** 刷新库清单：若当前正打开某个库，用新行同步它的文档数与名称，避免详情页停在旧值 */
  async function loadBases(): Promise<void> {
    loading.value = true;
    try {
      const rows = await api.listKnowledgeBases();
      bases.value = rows;
      const current = activeBase.value;
      if (current) activeBase.value = rows.find((base) => base.id === current.id) ?? null;
    } catch (error) {
      bases.value = [];
      notice.value = toErrorMessage(error);
    } finally {
      loading.value = false;
    }
  }

  function enter(base: KnowledgeBaseView): void {
    notice.value = '';
    activeBase.value = base;
  }

  /** 返回库列表：顺手刷新一次，把详情里上传 / 删除造成的文档数变化带回去 */
  async function back(): Promise<void> {
    activeBase.value = null;
    notice.value = '';
    await loadBases();
  }

  function resetEditor(): void {
    editor.id = null;
    editor.name = '';
    editor.description = '';
    editor.busy = false;
    editor.error = '';
  }

  function openCreate(): void {
    resetEditor();
    editor.mode = 'create';
    editor.visible = true;
  }

  function openEdit(base: KnowledgeBaseView): void {
    resetEditor();
    editor.mode = 'edit';
    editor.id = base.id;
    editor.name = base.name;
    editor.description = base.description ?? '';
    editor.visible = true;
  }

  function closeEditor(): void {
    editor.visible = false;
    editor.error = '';
  }

  /** 提交新建 / 编辑：名称本地先校验一遍，服务端仍会按其口径复核 */
  async function submitEditor(): Promise<void> {
    if (editor.busy) return;
    const name = editor.name.trim();
    if (!name) {
      editor.error = '知识库名称不能为空';
      return;
    }
    if (name.length > NAME_MAX_LENGTH) {
      editor.error = `知识库名称不能超过 ${NAME_MAX_LENGTH} 个字符`;
      return;
    }

    editor.busy = true;
    editor.error = '';
    try {
      const description = editor.description.trim() || null;
      if (editor.mode === 'create') {
        const created = await api.createKnowledgeBase({
          name,
          // 创建入参不接受 null：没有描述就不带该字段
          ...(description ? { description } : {}),
        });
        editor.visible = false;
        notice.value = `已创建知识库「${created.name}」`;
        await loadBases();
        // 新建后直接进入该库，用户接着就能上传文档
        enter(
          bases.value.find((base) => base.id === created.id) ?? { ...created, documentCount: 0 },
        );
      } else {
        const id = editor.id;
        if (!id) return;
        const updated = await api.updateKnowledgeBase(id, { name, description });
        editor.visible = false;
        notice.value = '知识库已更新';
        await loadBases();
        if (activeBase.value?.id === id) {
          activeBase.value = { ...activeBase.value, ...updated };
        }
      }
    } catch (error) {
      editor.error = toErrorMessage(error);
    } finally {
      editor.busy = false;
    }
  }

  function requestDelete(base: KnowledgeBaseView): void {
    deleteTarget.value = base;
  }

  function cancelDelete(): void {
    deleteTarget.value = null;
  }

  /** 删除库：文档与片段由服务端级联清理，前端只负责二次确认与回读清单 */
  async function confirmDelete(): Promise<void> {
    const target = deleteTarget.value;
    if (!target) return;
    try {
      await api.deleteKnowledgeBase(target.id);
      deleteTarget.value = null;
      if (activeBase.value?.id === target.id) activeBase.value = null;
      notice.value = `已删除知识库「${target.name}」`;
      await loadBases();
    } catch (error) {
      deleteTarget.value = null;
      notice.value = toErrorMessage(error);
    }
  }

  return {
    bases,
    loading,
    activeBase,
    editor,
    deleteTarget,
    loadBases,
    enter,
    back,
    openCreate,
    openEdit,
    closeEditor,
    submitEditor,
    requestDelete,
    cancelDelete,
    confirmDelete,
  };
}
