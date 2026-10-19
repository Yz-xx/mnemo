import { onMounted, reactive, ref } from 'vue';
import { AgentApi } from '../../api/client';
import { token } from '../../api/session';
import { useKnowledgeForm } from './useKnowledgeForm';
import { useKnowledgeList } from './useKnowledgeList';

/** KnowledgePanel 的入参：地址由抽屉传入，优先取其未保存的草稿 */
export interface KnowledgePanelProps {
  backendUrl: string;
}

/**
 * 知识库文档的读写编排：接口需要鉴权，复用同一份登录令牌。
 * 出口按关注点收敛成 form / list 两组；操作提示位被两侧共同读写，由本层创建后注入。
 */
export function useKnowledgePanel(props: KnowledgePanelProps) {
  // 地址取抽屉传入的草稿、令牌取当前登录态，两者都经取值器注入：
  // 便于在保存设置前先验证目标服务，地址草稿变化也无需重建实例
  const api = new AgentApi(
    () => props.backendUrl,
    () => token.value,
  );

  /** 操作提示位：入库成功、加载失败与删除结果共用 */
  const notice = ref('');

  const list = useKnowledgeList({ notice, api });
  const form = useKnowledgeForm({ notice, api, loadDocuments: list.loadDocuments });

  onMounted(() => void list.loadDocuments());

  // 分组包一层 reactive：嵌套在普通对象里的 ref 在模板中不会被解包，包过 reactive 才会
  return {
    form: reactive({
      title: form.title,
      content: form.content,
      busy: form.busy,
      addDocument: form.addDocument,
    }),
    list: reactive({
      documents: list.documents,
      notice,
      removeDocument: list.removeDocument,
    }),
  };
}
