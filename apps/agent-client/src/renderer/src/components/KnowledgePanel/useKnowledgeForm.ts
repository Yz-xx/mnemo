import type { AgentApi } from '../../api/client';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { toErrorMessage } from '../../api/client';

interface KnowledgeFormDeps {
  /** 操作提示位：入库成功与失败的原因都写这里，列表侧同源 */
  notice: Ref<string>;
  /** 地址取抽屉草稿、令牌取当前登录态的实例 */
  api: AgentApi;
  /** 入库成功后回读列表：新文档要立刻出现在列表里 */
  loadDocuments: () => Promise<void>;
}

export interface KnowledgeFormControls {
  title: Ref<string>;
  content: Ref<string>;
  busy: Ref<boolean>;
  addDocument: () => Promise<void>;
}

/** 知识库文档的登记：输入与提交锁归此，列表回读经参数注入 */
export function useKnowledgeForm({
  notice,
  api,
  loadDocuments,
}: KnowledgeFormDeps): KnowledgeFormControls {
  const title = ref('');
  const content = ref('');
  const busy = ref(false);

  async function addDocument(): Promise<void> {
    if (!content.value.trim() || busy.value) return;
    busy.value = true;
    notice.value = '';
    try {
      await api.addDocument({ title: title.value, content: content.value });
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

  return { title, content, busy, addDocument };
}
