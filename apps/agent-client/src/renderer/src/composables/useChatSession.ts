import type { ChatMessage, ConversationSummary } from '../types';
import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { isUnauthorized } from '../api/client';
import { agentApi } from '../api/session';

interface ChatSessionDeps {
  /** 共享的消息列表：切换历史会话要整表替换，新建会话要清空 */
  messages: Ref<ChatMessage[]>;
  /** 共享的当前会话 ID：select 与新建都要改写，由入口持有后注入 */
  activeId: Ref<string | null>;
  /** 共享的流式标记：回复进行中不允许切换会话 */
  streaming: Ref<boolean>;
  /** 对话区的错误位 */
  errorMessage: Ref<string>;
  /** 令牌失效的统一处理：列表拉取失败也要收敛到登录页 */
  handleUnauthorized: () => Promise<void>;
  /** 请求错误的统一处理 */
  handleError: (error: unknown) => Promise<void>;
  /** 中断进行中的流：切换或新建会话前必须先停下当前回复 */
  abortStream: () => void;
}

export interface ChatSessionControls {
  conversations: Ref<ConversationSummary[]>;
  /** 当前会话绑定的知识库：新会话为 null，选库器据此决定可编辑还是只读 */
  activeKnowledgeBaseId: ComputedRef<string | null>;
  loading: Ref<boolean>;
  refreshConversations: () => Promise<void>;
  startNewConversation: () => void;
  selectConversation: (id: string) => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  clearSession: () => void;
}

/**
 * 会话列表与切换：列表取数、历史会话回看、删除与重命名都归此，
 * 消息体、当前会话与流的中断属其他关注点，经参数注入。
 */
export function useChatSession({
  messages,
  activeId,
  streaming,
  errorMessage,
  handleUnauthorized,
  handleError,
  abortStream,
}: ChatSessionDeps): ChatSessionControls {
  const conversations = ref<ConversationSummary[]>([]);
  const loading = ref(false);

  // 切换请求序号：快速点选两个会话时，先发出的响应可能后到，
  // 只认最后一次发出的请求，避免旧会话内容覆盖新选中的会话
  let selectSeq = 0;

  /**
   * 当前打开会话的绑定库：会话列表已带该字段，打开时无需再读详情。
   * 新建会话（activeId 为 null）时为空，选库器因此回到可编辑状态。
   */
  const activeKnowledgeBaseId = computed(
    () => conversations.value.find((item) => item.id === activeId.value)?.knowledgeBaseId ?? null,
  );

  /** 拉取会话列表；失败时清空并让 401 收敛到登录页，其余错误不额外提示 */
  async function refreshConversations(): Promise<void> {
    try {
      conversations.value = await agentApi.listConversations();
    } catch (error) {
      conversations.value = [];
      if (isUnauthorized(error)) await handleUnauthorized();
    }
  }

  /** 开启新对话：仅清空当前上下文，真正的会话由后端在首次提问时创建 */
  function startNewConversation(): void {
    abortStream();
    // 使在途的历史会话请求失效，否则它返回后会覆盖刚清空的对话
    selectSeq += 1;
    loading.value = false;
    activeId.value = null;
    messages.value = [];
    errorMessage.value = '';
  }

  async function selectConversation(id: string): Promise<void> {
    if (streaming.value || id === activeId.value) return;
    const requestId = ++selectSeq;
    loading.value = true;
    errorMessage.value = '';
    try {
      const detail = await agentApi.getConversation(id);
      // 过期响应只丢弃，不改写当前会话与消息
      if (requestId !== selectSeq) return;
      activeId.value = detail.id;
      // 服务端存的是工具名数组（tools），渲染层统一用 steps（已完成态）展示，
      // 这里做一次转换，切换历史会话后工具标签就不会凭空消失
      messages.value = detail.messages.map((message) =>
        message.tools?.length
          ? {
              ...message,
              steps: message.tools.map((name) => ({ name, running: false })),
            }
          : message,
      );
    } catch (error) {
      if (requestId !== selectSeq) return;
      await handleError(error);
    } finally {
      // 过期请求不得收尾，否则会提前熄掉最新请求的加载态
      if (requestId === selectSeq) loading.value = false;
    }
  }

  async function removeConversation(id: string): Promise<void> {
    try {
      await agentApi.deleteConversation(id);
      if (id === activeId.value) startNewConversation();
      await refreshConversations();
    } catch (error) {
      await handleError(error);
    }
  }

  /** 重命名会话：成功后只改本地条目标题，列表顺序与消息数都不变，不为此整表重拉 */
  async function renameConversation(id: string, title: string): Promise<void> {
    try {
      const updated = await agentApi.renameConversation(id, title);
      const target = conversations.value.find((item) => item.id === id);
      if (target) target.title = updated.title;
    } catch (error) {
      await handleError(error);
    }
  }

  /** 登出或令牌失效时清空会话数据，避免上一个账号的内容残留在界面上 */
  function clearSession(): void {
    // 与新建同理：登出后不能让在途请求把上一个账号的内容写回来
    selectSeq += 1;
    loading.value = false;
    activeId.value = null;
    conversations.value = [];
  }

  return {
    conversations,
    activeKnowledgeBaseId,
    loading,
    refreshConversations,
    startNewConversation,
    selectConversation,
    removeConversation,
    renameConversation,
    clearSession,
  };
}
