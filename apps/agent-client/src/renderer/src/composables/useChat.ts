import type { HealthInfo } from '../api/client';
import type { ChatMessage, ConversationSummary, GeneratedFileInfo } from '../types';
import { computed, ref } from 'vue';
import { DEFAULT_BACKEND_URL, readSettings, saveFile, saveSettings } from '../api/bridge';
import { isUnauthorized, SESSION_EXPIRED_MESSAGE, toErrorMessage } from '../api/client';
import { agentApi, backendUrl, setBackendUrl } from '../api/session';
import { consumeChatStream, createMessage } from './chatStream';
import { useAuth } from './useAuth';
import { useChatAttachments } from './useChatAttachments';

export type ConnectionState = 'idle' | 'online' | 'offline';

/** 桌面端会话状态与流式对话逻辑 */
export function useChat() {
  const { clear, errorMessage: authError } = useAuth();

  const connection = ref<ConnectionState>('idle');
  const health = ref<HealthInfo | null>(null);
  const conversations = ref<ConversationSummary[]>([]);
  const activeId = ref<string | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const streaming = ref(false);
  const loadingConversation = ref(false);
  const errorMessage = ref('');

  let controller: AbortController | null = null;

  const canSend = computed(() => connection.value === 'online' && !streaming.value);

  /**
   * 令牌失效的统一处理：清空登录态把界面交还登录页，并把失效原因留在登录页。
   * 提示必须写在 clear() 之后——clear() 会清空登录页的提示位，先写会被立刻抹掉。
   */
  async function handleUnauthorized(): Promise<void> {
    await clear();
    authError.value = SESSION_EXPIRED_MESSAGE;
  }

  // 附件的上传与就绪判定自成一块；令牌失效的处理归本层，故以回调注入
  const { attachments, addAttachment, removeAttachment, clearAttachments, takeReadyAttachments } =
    useChatAttachments(handleUnauthorized);

  /** 统一的请求错误处理：令牌失效时清理登录态，其余情况把原因留在对话区 */
  async function handleError(error: unknown): Promise<void> {
    if (isUnauthorized(error)) {
      await handleUnauthorized();
      return;
    }
    errorMessage.value = toErrorMessage(error);
  }

  /** 退出登录或令牌失效时清空本地会话数据，避免上一个账号的内容残留在界面上 */
  function reset(): void {
    controller?.abort();
    controller = null;
    activeId.value = null;
    conversations.value = [];
    messages.value = [];
    clearAttachments();
    errorMessage.value = '';
    connection.value = 'idle';
    health.value = null;
  }

  /** 探测后端可用性，同时刷新当前模型信息 */
  async function refreshHealth(): Promise<void> {
    try {
      health.value = await agentApi.health();
      connection.value = 'online';
      errorMessage.value = '';
    } catch {
      health.value = null;
      connection.value = 'offline';
    }
  }

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
    controller?.abort();
    activeId.value = null;
    messages.value = [];
    errorMessage.value = '';
  }

  async function selectConversation(id: string): Promise<void> {
    if (streaming.value || id === activeId.value) return;
    loadingConversation.value = true;
    errorMessage.value = '';
    try {
      const detail = await agentApi.getConversation(id);
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
      await handleError(error);
    } finally {
      loadingConversation.value = false;
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

  /** 发送消息并以流式方式增量渲染回复 */
  async function sendMessage(text: string): Promise<void> {
    const content = text.trim();
    if (!content || !canSend.value) return;

    // 取走本轮可发出的附件：上传中或失败的条目留在输入区由用户处理
    const ready = takeReadyAttachments();

    messages.value.push(createMessage('user', content, ready.names));
    // 预先插入空的助手消息，后续 token 直接追加到该条上
    const assistant = ref(createMessage('assistant', ''));
    messages.value.push(assistant.value);

    streaming.value = true;
    errorMessage.value = '';
    // 保留局部引用：用户中途停止时会把 controller 置空，局部引用仍可用于判断是否被中断
    const currentController = new AbortController();
    controller = currentController;

    try {
      await consumeChatStream(
        agentApi.streamChat(
          { conversationId: activeId.value ?? undefined, message: content, fileIds: ready.fileIds },
          currentController.signal,
        ),
        assistant.value,
        {
          // 首个产出时后端即告知会话 ID：新建的会话从此刻起一定保留，
          // 先记下来，用户中途停止也还能接着这条会话继续发
          onConversation: (conversationId) => {
            activeId.value = conversationId;
          },
          // done 事件由后端确认会话 ID，随后刷新列表以更新标题与排序
          onDone: async (conversationId) => {
            activeId.value = conversationId;
            await refreshConversations();
          },
          onError: (message) => {
            errorMessage.value = message;
          },
        },
      );
    } catch (error) {
      // 用户主动中断不算错误；令牌失效同样经此收敛到登录页
      if (!currentController.signal.aborted) await handleError(error);
    } finally {
      streaming.value = false;
      controller = null;
      // 中断或异常时可能收不到工具的 end 事件，把仍在执行中的标签就地定格，
      // 否则转圈会一直留在界面上，看起来像还没结束
      const steps = assistant.value.steps;
      if (steps?.some((step) => step.running)) {
        assistant.value.steps = steps.map((step) =>
          step.running ? { ...step, running: false } : step,
        );
      }
      if (!assistant.value.content) {
        messages.value = messages.value.filter((item) => item.id !== assistant.value.id);
      }
    }
  }

  function stopStreaming(): void {
    controller?.abort();
    controller = null;
  }

  /** 切换后端地址并持久化到本地设置 */
  async function updateBackendUrl(url: string): Promise<void> {
    const nextUrl = url.trim() || DEFAULT_BACKEND_URL;
    setBackendUrl(nextUrl);
    await saveSettings({ backendUrl: nextUrl });
    connection.value = 'idle';
    await refreshHealth();
    await refreshConversations();
  }

  /**
   * 保存智能体生成的导出文件：从后端取回字节后交主进程写盘。
   * 用户在保存对话框里取消不算失败，静默结束即可。
   */
  async function saveGeneratedFile(file: GeneratedFileInfo): Promise<void> {
    try {
      const bytes = await agentApi.downloadFile(file.fileId);
      await saveFile({ name: file.name, bytes: new Uint8Array(bytes) });
    } catch (error) {
      await handleError(error);
    }
  }

  /** 启动时读取本地设置并完成首次连接 */
  async function init(): Promise<void> {
    const settings = await readSettings();
    setBackendUrl(settings.backendUrl);
    await refreshHealth();
    await refreshConversations();
  }

  return {
    backendUrl,
    connection,
    health,
    conversations,
    activeId,
    messages,
    streaming,
    loadingConversation,
    errorMessage,
    canSend,
    attachments,
    addAttachment,
    removeAttachment,
    init,
    reset,
    refreshHealth,
    sendMessage,
    stopStreaming,
    startNewConversation,
    selectConversation,
    removeConversation,
    updateBackendUrl,
    saveGeneratedFile,
  };
}
