import type { ChatMessage, GeneratedFileInfo } from '../types';
import type { ReadyAttachments } from './useChatAttachments';
import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { saveFile } from '../api/bridge';
import { agentApi } from '../api/session';
import { consumeChatStream, createMessage } from './chatStream';

interface ChatMessagesDeps {
  /** 共享的消息列表：本 hook 是它的主要写者（发送、追加 token、定格工具标签） */
  messages: Ref<ChatMessage[]>;
  /** 共享的流式标记：供会话组判断能否切换，也用于禁用发送 */
  streaming: Ref<boolean>;
  /** 共享的当前会话 ID：流事件回填与续发都靠它 */
  activeId: Ref<string | null>;
  /** 对话区的错误位 */
  errorMessage: Ref<string>;
  /** 后端是否在线：与流式标记共同决定能否发送 */
  isOnline: () => boolean;
  /** 助手回复落定后刷新会话列表，更新标题与排序 */
  refreshConversations: () => Promise<void>;
  /** 取走本轮已就绪的附件，随提问一起提交 */
  takeReadyAttachments: () => ReadyAttachments;
  /** 请求错误的统一处理 */
  handleError: (error: unknown) => Promise<void>;
}

export interface ChatMessagesControls {
  canSend: ComputedRef<boolean>;
  sendMessage: (text: string) => Promise<void>;
  stopStreaming: () => void;
  saveGeneratedFile: (file: GeneratedFileInfo) => Promise<void>;
}

/**
 * 对话收发：流式回复的消费、中断与导出文件保存都归此，
 * 消息列表、当前会话、流式标记由入口创建后注入，中断控制器与发送锁是本 hook 的本体。
 */
export function useChatMessages({
  messages,
  streaming,
  activeId,
  errorMessage,
  isOnline,
  refreshConversations,
  takeReadyAttachments,
  handleError,
}: ChatMessagesDeps): ChatMessagesControls {
  let controller: AbortController | null = null;

  const canSend = computed(() => isOnline() && !streaming.value);

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

  return { canSend, sendMessage, stopStreaming, saveGeneratedFile };
}
