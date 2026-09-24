import { computed, ref } from 'vue';
import { AgentApi, type HealthInfo } from '../api/client';
import type { ChatMessage, ConversationSummary } from '../types';

const DEFAULT_BACKEND_URL = 'http://localhost:3000';

export type ConnectionState = 'idle' | 'online' | 'offline';

/** 桌面端会话状态与流式对话逻辑 */
export function useChat() {
  const backendUrl = ref(DEFAULT_BACKEND_URL);
  const api = computed(() => new AgentApi(backendUrl.value));

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
    } catch {
      conversations.value = [];
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
      errorMessage.value = toMessage(error);
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
      errorMessage.value = toMessage(error);
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
      const stream = api.value.streamChat(
        { conversationId: activeId.value ?? undefined, message: content },
        currentController.signal,
      );
      for await (const event of stream) {
        if (event.type === 'token') {
          assistant.value.content += event.content;
        } else if (event.type === 'tool') {
          const label = event.status === 'start' ? `调用工具 ${event.name}` : `完成 ${event.name}`;
          assistant.value.steps = [...(assistant.value.steps ?? []), label];
        } else if (event.type === 'done') {
          activeId.value = event.conversationId;
          await refreshConversations();
        } else if (event.type === 'error') {
          errorMessage.value = event.message;
        }
      }
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
