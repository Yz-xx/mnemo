import type { AgentApi } from '../../api/client';
import type { KnowledgeDocument } from '../../types';
import type { ComputedRef, Ref } from 'vue';
import { computed, onUnmounted, ref } from 'vue';
import { toErrorMessage } from '../../api/client';

interface KnowledgeListDeps {
  /** 操作提示位：加载失败与删除结果的提示都写这里，与库管理侧同源 */
  notice: Ref<string>;
  /** 地址取抽屉草稿、令牌取当前登录态的实例 */
  api: AgentApi;
  /** 当前详情库 ID 取值器：切换库后取到新库，为空表示停留在库列表页 */
  getBaseId: () => string | null;
}

export interface KnowledgeListControls {
  documents: Ref<KnowledgeDocument[]>;
  isEmpty: ComputedRef<boolean>;
  loadDocuments: () => Promise<void>;
  removeDocument: (id: string) => Promise<void>;
  retryDocument: (id: string) => Promise<void>;
}

/** 解析中轮询：首次 2 秒后查，之后按 2 倍退避，封顶 30 秒 */
const POLL_INITIAL_MS = 2_000;
const POLL_MAX_MS = 30_000;

/**
 * 单个库的文档列表：取数、删除、重试与解析中轮询。
 * 只关心「当前打开的是哪个库」，库的增删改由 `useKnowledgeBases` 负责。
 * 列表里只要还有 processing 文档就按时刷新，全部落定后自然停止。
 */
export function useKnowledgeList({
  notice,
  api,
  getBaseId,
}: KnowledgeListDeps): KnowledgeListControls {
  const documents = ref<KnowledgeDocument[]>([]);
  const isEmpty = computed(() => documents.value.length === 0);

  /** 轮询定时器与当前间隔：页面卸载即清，退避在无 processing 文档时复位 */
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollDelayMs = POLL_INITIAL_MS;
  // 切库后旧库的响应可能后到：只认最后一次发出的请求，避免旧列表写回新库
  let loadSeq = 0;

  /** 列表里是否仍有文档在解析：决定要不要继续轮询 */
  function hasProcessing(): boolean {
    return documents.value.some((document) => document.status === 'processing');
  }

  /** 安排下一次轮询：解析大文件可能很久，固定间隔会白白刷一整天 */
  function schedulePoll(): void {
    if (!hasProcessing()) {
      pollDelayMs = POLL_INITIAL_MS;
      return;
    }
    if (pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      // 先加倍再刷新：下一轮若仍在解析，等待更久，最长 30 秒
      pollDelayMs = Math.min(pollDelayMs * 2, POLL_MAX_MS);
      void loadDocuments();
    }, pollDelayMs);
  }

  async function loadDocuments(): Promise<void> {
    const baseId = getBaseId();
    const seq = ++loadSeq;
    if (!baseId) {
      documents.value = [];
      schedulePoll();
      return;
    }
    try {
      const rows = await api.listDocuments(baseId);
      if (seq !== loadSeq) return;
      documents.value = rows;
    } catch (error) {
      if (seq !== loadSeq) return;
      // 加载失败与「确实没有文档」必须区分：只清空不提示会让用户误以为库被清空
      documents.value = [];
      notice.value = toErrorMessage(error);
    } finally {
      if (seq === loadSeq) schedulePoll();
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

  /** 重试解析：服务端重置为 processing 并重新入队，刷新后轮询接管状态变化 */
  async function retryDocument(id: string): Promise<void> {
    try {
      notice.value = '';
      await api.retryDocument(id);
      await loadDocuments();
    } catch (error) {
      notice.value = toErrorMessage(error);
    }
  }

  // 离开面板即停轮询：抽屉切到其他分页会卸载本组件，此时不该再有请求发出
  onUnmounted(() => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  });

  return { documents, isEmpty, loadDocuments, removeDocument, retryDocument };
}
