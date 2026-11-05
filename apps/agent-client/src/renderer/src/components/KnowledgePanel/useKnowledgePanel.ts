import type { KnowledgeDocumentStatus } from '../../types';
import { onMounted, reactive, ref, watch } from 'vue';
import { AgentApi } from '../../api/client';
import { token } from '../../api/session';
import { useKnowledgeBases } from './useKnowledgeBases';
import { useKnowledgeForm } from './useKnowledgeForm';
import { useKnowledgeList } from './useKnowledgeList';
import { useKnowledgeUpload } from './useKnowledgeUpload';

/** KnowledgePanel 的入参：地址由抽屉传入，优先取其未保存的草稿 */
export interface KnowledgePanelProps {
  backendUrl: string;
}

/** 解析状态的展示文案：徽标与失败原因共用同一套说法 */
const STATUS_TEXT: Record<KnowledgeDocumentStatus, string> = {
  processing: '解析中',
  ready: '可用',
  failed: '解析失败',
};

/**
 * 知识库管理编排：库清单与当前库由 bases 持有，文档列表、粘贴入库与文件上传
 * 都挂在「当前库」上，因此统一以取值器取库 ID——进入 / 返回时无需重置各子 hook。
 * 操作提示位被四处共同读写，由本层创建后注入。
 */
export function useKnowledgePanel(props: KnowledgePanelProps) {
  // 地址取抽屉传入的草稿、令牌取当前登录态，两者都经取值器注入：
  // 便于在保存设置前先验证目标服务，地址草稿变化也无需重建实例
  const api = new AgentApi(
    () => props.backendUrl,
    () => token.value,
  );

  /** 操作提示位：库增删改、上传结果与加载失败共用 */
  const notice = ref('');

  const baseState = useKnowledgeBases({ notice, api });

  /** 详情页当前库 ID：为空表示停留在库列表页，各文档侧 hook 据此短路 */
  const getBaseId = (): string | null => baseState.activeBase.value?.id ?? null;

  const list = useKnowledgeList({ notice, api, getBaseId });
  const form = useKnowledgeForm({ notice, api, getBaseId, loadDocuments: list.loadDocuments });
  // 上传成功后同样回读列表：新文档先以「解析中」出现，轮询由列表侧接管
  const upload = useKnowledgeUpload({
    notice,
    api,
    getBaseId,
    loadDocuments: list.loadDocuments,
  });

  onMounted(() => void baseState.loadBases());

  // 进入或返回库详情都重取文档：返回时取到的库 ID 为空，列表随之清空
  watch(
    () => baseState.activeBase.value?.id ?? null,
    () => void list.loadDocuments(),
  );

  // 分组包一层 reactive：嵌套在普通对象里的 ref 在模板中不会被解包，包过 reactive 才会
  return {
    baseState: reactive({
      bases: baseState.bases,
      activeBase: baseState.activeBase,
      loading: baseState.loading,
      editor: baseState.editor,
      deleteTarget: baseState.deleteTarget,
      enter: baseState.enter,
      back: baseState.back,
      openCreate: baseState.openCreate,
      openEdit: baseState.openEdit,
      closeEditor: baseState.closeEditor,
      submitEditor: baseState.submitEditor,
      requestDelete: baseState.requestDelete,
      cancelDelete: baseState.cancelDelete,
      confirmDelete: baseState.confirmDelete,
    }),
    form: reactive({
      title: form.title,
      content: form.content,
      busy: form.busy,
      addDocument: form.addDocument,
    }),
    upload: reactive({
      file: upload.file,
      progress: upload.progress,
      uploading: upload.uploading,
      selectFile: upload.selectFile,
      dropFile: upload.dropFile,
      upload: upload.upload,
      cancel: upload.cancel,
    }),
    list: reactive({
      documents: list.documents,
      isEmpty: list.isEmpty,
      notice,
      removeDocument: list.removeDocument,
      retryDocument: list.retryDocument,
    }),
    STATUS_TEXT,
  };
}
