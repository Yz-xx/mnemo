import { computed, ref } from 'vue';
import { DEFAULT_BACKEND_URL, openFile, readSettings, saveFile, saveSettings } from '../api/bridge';
import {
  AgentApi,
  SESSION_EXPIRED_MESSAGE,
  isUnauthorized,
  toErrorMessage,
  type ChatStreamEvent,
  type HealthInfo,
} from '../api/client';
import type { ChatAttachment, ChatMessage, ConversationSummary, GeneratedFileInfo } from '../types';
import { useAuth } from './useAuth';

export type ConnectionState = 'idle' | 'online' | 'offline';

/** 桌面端会话状态与流式对话逻辑 */
export function useChat() {
  const { token, clear, errorMessage: authError } = useAuth();
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
  /** 待发送附件：选中即上传，发送成功后随本轮一起清空 */
  const attachments = ref<ChatAttachment[]>([]);

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
    attachments.value = [];
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
      const detail = await api.value.getConversation(id);
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
      await api.value.deleteConversation(id);
      if (id === activeId.value) startNewConversation();
      await refreshConversations();
    } catch (error) {
      await handleError(error);
    }
  }

  /** 更新指定附件的部分字段：整表替换触发响应式，避免逐项改对象时漏掉更新 */
  function patchAttachment(key: string, patch: Partial<ChatAttachment>): void {
    attachments.value = attachments.value.map((item) =>
      item.key === key ? { ...item, ...patch } : item,
    );
  }

  /** 选择附件：选中后立刻上传换取服务端 ID，免得等到发送时才发现类型不支持 */
  async function addAttachment(): Promise<void> {
    const selected = await openFile();
    if (!selected) return;

    const attachment: ChatAttachment = {
      key: crypto.randomUUID(),
      name: selected.name,
      size: selected.size,
    };
    attachments.value = [...attachments.value, attachment];
    try {
      const stored = await api.value.uploadFile(selected);
      patchAttachment(attachment.key, { fileId: stored.id });
    } catch (error) {
      // 失败原因留在该条附件上：用户可以单独把它移除，不影响其余附件
      if (isUnauthorized(error)) {
        await handleUnauthorized();
        return;
      }
      patchAttachment(attachment.key, { error: toErrorMessage(error) });
    }
  }

  function removeAttachment(key: string): void {
    attachments.value = attachments.value.filter((item) => item.key !== key);
  }

  /** 发送消息并以流式方式增量渲染回复 */
  async function sendMessage(text: string): Promise<void> {
    const content = text.trim();
    if (!content || !canSend.value) return;

    // 只有上传成功、拿到服务端 ID 的附件才随本轮发出；上传中或失败的条目留在输入区由用户处理
    const ready = attachments.value.filter((item) => item.fileId);
    const fileIds = ready.map((item) => item.fileId as string);

    messages.value.push(
      createMessage(
        'user',
        content,
        ready.map((item) => item.name),
      ),
    );
    // 附件已随本轮提交给后端，输入区只清掉这些已就绪的条目，
    // 上传中或上传失败的仍留在输入区由用户处理，不能被无声吞掉
    attachments.value = attachments.value.filter((item) => !item.fileId);
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
          { conversationId: activeId.value ?? undefined, message: content, fileIds },
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
    backendUrl.value = url.trim() || DEFAULT_BACKEND_URL;
    await saveSettings({ backendUrl: backendUrl.value });
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
      const bytes = await api.value.downloadFile(file.fileId);
      await saveFile({ name: file.name, bytes: new Uint8Array(bytes) });
    } catch (error) {
      await handleError(error);
    }
  }

  /** 启动时读取本地设置并完成首次连接 */
  async function init(): Promise<void> {
    const settings = await readSettings();
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

function createMessage(
  role: ChatMessage['role'],
  content: string,
  attachments?: string[],
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    // 无附件的消息不落该字段，省得每条消息都挂一个恒空的属性
    ...(attachments?.length ? { attachments } : {}),
  };
}

/** 消费流式事件时需要回传给会话层的副作用 */
interface ChatStreamHandlers {
  /** 本轮开始有产出，后端确认该会话会被保留，携带会话 ID */
  onConversation: (conversationId: string) => void;
  /** 本轮结束，携带后端确认的会话 ID */
  onDone: (conversationId: string) => Promise<void>;
  /** 后端返回的可读错误信息 */
  onError: (message: string) => void;
}

/**
 * 逐条消费 SSE 事件并合并进助手消息：token 累加正文，tool 追加为执行轨迹；
 * 会话级副作用（记住会话 ID、切换会话、报错提示）通过回调交回调用方，保持此处逻辑纯粹。
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
      const steps = message.steps ?? [];
      if (event.status === 'start') {
        // 先落一条进行中的标签：读文件这类慢工具要立刻给出可见反馈
        message.steps = [...steps, { name: event.name, running: true }];
      } else {
        // 执行结束，把进行中的标签就地定格；后端对同名工具的 start 只推一次，
        // 配不上时补一条已完成记录，这次调用才不会从前端凭空消失
        const index = steps.findIndex((step) => step.running && step.name === event.name);
        message.steps =
          index === -1
            ? [...steps, { name: event.name, running: false }]
            : steps.map((step, i) => (i === index ? { ...step, running: false } : step));
      }
    } else if (event.type === 'file') {
      // 生成的文件挂在助手消息上：客户端据此渲染下载入口，文件本体不随流传输
      message.files = [
        ...(message.files ?? []),
        { fileId: event.fileId, name: event.name, size: event.size },
      ];
    } else if (event.type === 'source') {
      // 检索来源挂在助手消息上：同一份文档被多次命中时只留一个标签
      const sources = message.sources ?? [];
      if (!sources.includes(event.name)) message.sources = [...sources, event.name];
    } else if (event.type === 'conversation') {
      handlers.onConversation(event.conversationId);
    } else if (event.type === 'done') {
      await handlers.onDone(event.conversationId);
    } else {
      // 联合类型已把其余分支排除，走到这里只剩 error
      handlers.onError(event.message);
    }
  }
}
