import { computed, ref } from 'vue';
import { AgentApi, isUnauthorized, type HealthInfo } from '../api/client';
import type { ChatMessage, ChatStreamEvent, ConversationSummary } from '../types';
import { useAuth } from './useAuth';

const DEFAULT_BACKEND_URL = 'http://localhost:3000';

export type ConnectionState = 'idle' | 'online' | 'offline';

/** 桌面端会话状态与流式对话逻辑 */
export function useChat() {
  const { token, clear } = useAuth();
  const backendUrl = ref(DEFAULT_BACKEND_URL);
  // 令牌变化时自动重建客户端，保证每次请求都携带当前登录态
  const api = computed(() => new AgentApi(backendUrl.value, token.value));

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

  /** 统一的请求错误处理：令牌失效时清理登录态，界面自动回到登录页 */
  function handleError(error: unknown): void {
    if (isUnauthorized(error)) {
      errorMessage.value = '登录已失效，请重新登录';
      void clear();
      return;
    }
    errorMessage.value = toMessage(error);
  }

  /** 退出登录或令牌失效时清空本地会话数据，避免上一个账号的内容残留在界面上 */
  function reset(): void {
    controller?.abort();
    controller = null;
    activeId.value = null;
    conversations.value = [];
    messages.value = [];
    errorMessage.value = '';
    connection.value = 'idle';
    health.value = null;
  }

  /** 探测后端可用性，同时刷新当前模型信息 */
  async function refreshHealth(): Promise<void> {
    try {
      health.value = await api.value.health();
      connection.value = 'online';
      errorMessage.value = '';
    } catch {
      health.value = null;
      connection.value = 'offline';
    }
  }

  async function refreshConversations(): Promise<void> {
    try {
      conversations.value = await api.value.listConversations();
    } catch (error) {
      conversations.value = [];
      if (isUnauthorized(error)) await clear();
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
      const detail = await api.value.getConversation(id);
      activeId.value = detail.id;
      messages.value = detail.messages;
    } catch (error) {
      handleError(error);
    } finally {
      loadingConversation.value = false;
    }
  }

  async function removeConversation(id: string): Promise<void> {
    try {
      await api.value.deleteConversation(id);
      if (id === activeId.value) startNewConversation();
      await refreshConversations();
    } catch (error) {
      handleError(error);
    }
  }

  /** 发送消息并以流式方式增量渲染回复 */
  async function sendMessage(text: string): Promise<void> {
    const content = text.trim();
    if (!content || !canSend.value) return;

    messages.value.push(createMessage('user', content));
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
        api.value.streamChat(
          { conversationId: activeId.value ?? undefined, message: content },
          currentController.signal,
        ),
        assistant.value,
        {
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
      // 用户主动中断不算错误
      if (!currentController.signal.aborted) errorMessage.value = toMessage(error);
    } finally {
      streaming.value = false;
      controller = null;
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
    backendUrl.value = url.trim() || DEFAULT_BACKEND_URL;
    await window.desktopApi.saveSettings({ backendUrl: backendUrl.value });
    connection.value = 'idle';
    await refreshHealth();
    await refreshConversations();
  }

  /** 启动时读取本地设置并完成首次连接 */
  async function init(): Promise<void> {
    const settings = await window.desktopApi.getSettings();
    backendUrl.value = settings.backendUrl;
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
    init,
    reset,
    refreshHealth,
    sendMessage,
    stopStreaming,
    startNewConversation,
    selectConversation,
    removeConversation,
    updateBackendUrl,
  };
}

function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: new Date().toISOString() };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 消费流式事件时需要回传给会话层的副作用 */
interface ChatStreamHandlers {
  /** 本轮结束，携带后端确认的会话 ID */
  onDone: (conversationId: string) => Promise<void>;
  /** 后端返回的可读错误信息 */
  onError: (message: string) => void;
}

/**
 * 逐条消费 SSE 事件并合并进助手消息：token 累加正文，tool 追加为执行轨迹；
 * 会话级副作用（切换会话、报错提示）通过回调交回调用方，保持此处逻辑纯粹。
 */
async function consumeChatStream(
  stream: AsyncIterable<ChatStreamEvent>,
  message: ChatMessage,
  handlers: ChatStreamHandlers,
): Promise<void> {
  for await (const event of stream) {
    if (event.type === 'token') {
      message.content += event.content;
    } else if (event.type === 'tool') {
      const label = event.status === 'start' ? `调用工具 ${event.name}` : `完成 ${event.name}`;
      message.steps = [...(message.steps ?? []), label];
    } else if (event.type === 'done') {
      await handlers.onDone(event.conversationId);
    } else {
      handlers.onError(event.message);
    }
  }
}
