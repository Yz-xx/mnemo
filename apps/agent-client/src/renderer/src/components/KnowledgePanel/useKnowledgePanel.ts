import type { KnowledgeDocument } from '../../types';
import type { Ref } from 'vue';
import { onMounted, ref } from 'vue';
import { AgentApi, toErrorMessage } from '../../api/client';
import { useAuth } from '../../composables/useAuth';

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
    } catch (error) {
      // 加载失败与「确实没有文档」必须区分：只清空不提示会让用户误以为知识库被清空
      documents.value = [];
      notice.value = toErrorMessage(error);
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
      // 删除后必须清掉上一次操作的提示：否则列表已被清空，「文档已入库」还挂在上方，
      // 同时会把「知识库为空」的空态挡住，让人误以为里面还有内容
      notice.value = '';
      await loadDocuments();
    } catch (error) {
      notice.value = toErrorMessage(error);
    }
  }

  onMounted(() => void loadDocuments());

  return { documents, title, content, busy, notice, addDocument, removeDocument };
}
