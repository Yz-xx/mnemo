import { onMounted, ref } from 'vue';
import type { Ref } from 'vue';
import { AgentApi } from '../../api/client';
import { toErrorMessage } from '../../api/errors';
import { useAuth } from '../../composables/useAuth';
import type { KnowledgeDocument } from '../../types';

/** KnowledgePanel 的入参：地址由抽屉传入，优先取其未保存的草稿 */
export interface KnowledgePanelProps {
  backendUrl: string;
}

interface KnowledgePanelControls {
  documents: Ref<KnowledgeDocument[]>;
  title: Ref<string>;
  content: Ref<string>;
  busy: Ref<boolean>;
  notice: Ref<string>;
  addDocument: () => Promise<void>;
  removeDocument: (id: string) => Promise<void>;
}

/** 知识库文档的读写编排：接口需要鉴权，复用同一份登录令牌 */
export function useKnowledgePanel(props: KnowledgePanelProps): KnowledgePanelControls {
  const { token } = useAuth();

  const documents = ref<KnowledgeDocument[]>([]);
  const title = ref('');
  const content = ref('');
  const busy = ref(false);
  const notice = ref('');

  // 始终按传入地址访问，便于在保存设置前先验证目标服务
  const createApi = (): AgentApi => new AgentApi(props.backendUrl, token.value);

  async function loadDocuments(): Promise<void> {
    try {
      documents.value = await createApi().listDocuments();
    } catch {
      documents.value = [];
    }
  }

  async function addDocument(): Promise<void> {
    if (!content.value.trim() || busy.value) return;
    busy.value = true;
    notice.value = '';
    try {
      await createApi().addDocument({ title: title.value, content: content.value });
      title.value = '';
      content.value = '';
      notice.value = '文档已入库，可被智能体检索';
      await loadDocuments();
    } catch (error) {
      notice.value = toErrorMessage(error);
    } finally {
      busy.value = false;
    }
  }

  async function removeDocument(id: string): Promise<void> {
    try {
      await createApi().deleteDocument(id);
      await loadDocuments();
    } catch (error) {
      notice.value = toErrorMessage(error);
    }
  }

  onMounted(() => void loadDocuments());

  return { documents, title, content, busy, notice, addDocument, removeDocument };
}
