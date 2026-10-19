import type { AgentApi } from '../../api/client';
import type { KnowledgeDocument } from '../../types';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { toErrorMessage } from '../../api/client';

interface KnowledgeListDeps {
  /** 操作提示位：加载失败与删除结果的提示都写这里，登记提示由表单侧写 */
  notice: Ref<string>;
  /** 地址取抽屉草稿、令牌取当前登录态的实例 */
  api: AgentApi;
}

export interface KnowledgeListControls {
  documents: Ref<KnowledgeDocument[]>;
  loadDocuments: () => Promise<void>;
  removeDocument: (id: string) => Promise<void>;
}

/** 知识库文档列表的取数与删除：提示位由入口创建后注入，本 hook 不反向依赖表单侧 */
export function useKnowledgeList({ notice, api }: KnowledgeListDeps): KnowledgeListControls {
  const documents = ref<KnowledgeDocument[]>([]);

  async function loadDocuments(): Promise<void> {
    try {
      documents.value = await api.listDocuments();
    } catch (error) {
      // 加载失败与「确实没有文档」必须区分：只清空不提示会让用户误以为知识库被清空
      documents.value = [];
      notice.value = toErrorMessage(error);
    }
  }

  async function removeDocument(id: string): Promise<void> {
    try {
      await api.deleteDocument(id);
      // 删除后必须清掉上一次操作的提示：否则列表已被清空，「文档已入库」还挂在上方，
      // 同时会把「知识库为空」的空态挡住，让人误以为里面还有内容
      notice.value = '';
      await loadDocuments();
    } catch (error) {
      notice.value = toErrorMessage(error);
    }
  }

  return { documents, loadDocuments, removeDocument };
}
