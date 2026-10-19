export type { ConnectionState } from './useChatConnection';

import type { ChatMessage } from '../types';
import { reactive, ref } from 'vue';
import { readSettings } from '../api/bridge';
import { isUnauthorized, SESSION_EXPIRED_MESSAGE, toErrorMessage } from '../api/client';
import { backendUrl, setBackendUrl } from '../api/session';
import { useAuth } from './useAuth';
import { useChatAttachments } from './useChatAttachments';
import { useChatConnection } from './useChatConnection';
import { useChatMessages } from './useChatMessages';
import { useChatSession } from './useChatSession';

/**
 * 桌面端会话状态与流式对话逻辑。
 * 出口按关注点收敛成 backend / session / chat / attachments / lifecycle 五组：
 * 连接、会话列表、对话收发、附件各自成子 hook，消息列表、当前会话与错误位
 * 被其中几组共同改写，故由本层创建后经参数注入。
 */
export function useChat() {
  const auth = useAuth();

  // 共享状态：消息与当前会话被会话组、对话组共同改写；流式标记被三组读；错误位被四组读写
  const messages = ref<ChatMessage[]>([]);
  const streaming = ref(false);
  const activeId = ref<string | null>(null);
  const errorMessage = ref('');

  /**
   * 令牌失效的统一处理：清空登录态把界面交还登录页，并把失效原因留在登录页。
   * 提示必须写在 clear() 之后——clear() 会清空登录页的提示位，先写会被立刻抹掉。
   */
  async function handleUnauthorized(): Promise<void> {
    await auth.session.clear();
    auth.form.errorMessage = SESSION_EXPIRED_MESSAGE;
  }

  /** 统一的请求错误处理：令牌失效时清理登录态，其余情况把原因留在对话区 */
  async function handleError(error: unknown): Promise<void> {
    if (isUnauthorized(error)) {
      await handleUnauthorized();
      return;
    }
    errorMessage.value = toErrorMessage(error);
  }

  // 附件的上传与就绪判定自成一块；令牌失效的处理归本层，故以回调注入
  const attachments = useChatAttachments(handleUnauthorized);

  // 连接组要回读会话列表、会话组要中断进行中的流，两者互相引用：
  // 先用占位回调占位，子 hook 建好后再回指真实现（与 useUsersPage 的 onRowsReload 同一手法）
  let refreshConversations = async (): Promise<void> => {};
  let abortStream = (): void => {};

  const conn = useChatConnection({
    errorMessage,
    refreshConversations: () => refreshConversations(),
  });

  const session = useChatSession({
    messages,
    activeId,
    streaming,
    errorMessage,
    handleUnauthorized,
    handleError,
    abortStream: () => abortStream(),
  });

  const chat = useChatMessages({
    messages,
    streaming,
    activeId,
    errorMessage,
    isOnline: () => conn.connection.value === 'online',
    refreshConversations: () => refreshConversations(),
    takeReadyAttachments: attachments.takeReadyAttachments,
    handleError,
  });

  refreshConversations = session.refreshConversations;
  abortStream = chat.stopStreaming;

  /** 退出登录或令牌失效时清空本地会话数据，避免上一个账号的内容残留在界面上 */
  function reset(): void {
    abortStream();
    messages.value = [];
    session.clearSession();
    attachments.clearAttachments();
    errorMessage.value = '';
    conn.resetConnection();
  }

  /** 启动时读取本地设置并完成首次连接 */
  async function init(): Promise<void> {
    const settings = await readSettings();
    setBackendUrl(settings.backendUrl);
    await conn.refreshHealth();
    await session.refreshConversations();
  }

  // 分组包一层 reactive：嵌套在普通对象里的 ref 在模板中不会被解包，包过 reactive 才会
  return {
    backend: reactive({
      url: backendUrl,
      connection: conn.connection,
      health: conn.health,
      refreshHealth: conn.refreshHealth,
      updateBackendUrl: conn.updateBackendUrl,
    }),
    session: reactive({
      conversations: session.conversations,
      activeId,
      loading: session.loading,
      startNewConversation: session.startNewConversation,
      selectConversation: session.selectConversation,
      removeConversation: session.removeConversation,
    }),
    chat: reactive({
      messages,
      streaming,
      canSend: chat.canSend,
      errorMessage,
      sendMessage: chat.sendMessage,
      stopStreaming: chat.stopStreaming,
      saveGeneratedFile: chat.saveGeneratedFile,
    }),
    attachments: reactive({
      list: attachments.attachments,
      add: attachments.addAttachment,
      remove: attachments.removeAttachment,
    }),
    lifecycle: reactive({ init, reset }),
  };
}
