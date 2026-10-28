import type { ChatMessage, GeneratedFileInfo } from '../types';
import type { ReadyAttachments } from './useChatAttachments';
import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { saveFile } from '../api/bridge';
import { isNotFound, isUnauthorized } from '../api/client';
import { agentApi } from '../api/session';
import { consumeChatStream, createMessage } from './chatStream';
import { createFrameWriter } from './frameWriter';

/** 断开后的重连退避序列（毫秒）：服务端仍在后台生成，按此节奏尝试续传，用尽即降级 */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000];

/** 等待若干毫秒（重连退避用） */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
 * 对话收发：流式回复的消费、断线续传、停止与导出文件保存都归此，
 * 消息列表、当前会话、流式标记由入口创建后注入，中断控制器与发送锁是本 hook 的本体。
 *
 * 断线不再等于本轮结束：服务端把生成跑在轮次任务里，客户端断开只是退订。
 * 故这里的收尾是「直到收到 done / error 才算落定」，中途只退避重连；
 * 重连补不回来（轮次已过期、退避用尽）时才拉回服务端的最终内容兜底。
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
  /** 在途轮次 ID：停止时靠它通知服务端掐断生成（仅断开订阅的话它会继续跑完） */
  let roundId: string | null = null;

  const canSend = computed(() => isOnline() && !streaming.value);

  /** 发送消息并以流式方式增量渲染回复，断开时按退避重连续传 */
  async function sendMessage(text: string): Promise<void> {
    const content = text.trim();
    if (!content || !canSend.value) return;

    // 取走本轮可发出的附件：上传中或失败的条目留在输入区由用户处理
    const ready = takeReadyAttachments();

    messages.value.push(createMessage('user', content, ready.names));
    // 预先插入空的助手消息，后续 token 直接追加到该条上
    const assistant = ref(createMessage('assistant', ''));
    messages.value.push(assistant.value);

    // 正文与推理链逐 token 到达，先攒到缓冲、每帧提交一次：
    // 渲染次数因此从「token 数」降到「帧数」（见 docs/adr/0016 阶段 1）
    const contentWriter = createFrameWriter((chunk) => {
      assistant.value.content += chunk;
    });
    const thinkingWriter = createFrameWriter((chunk) => {
      assistant.value.thinking = (assistant.value.thinking ?? '') + chunk;
    });
    const writes = {
      appendContent: (chunk: string) => contentWriter.append(chunk),
      appendThinking: (chunk: string) => thinkingWriter.append(chunk),
    };

    streaming.value = true;
    errorMessage.value = '';
    // 保留局部引用：用户中途停止时会把 controller 置空，局部引用仍可用于判断是否被中断
    const currentController = new AbortController();
    controller = currentController;
    const currentRoundId = crypto.randomUUID();
    roundId = currentRoundId;

    // 已消费到的最大帧序号：续传时上报它，服务端只重放之后的帧
    let lastSeq = 0;
    // 本轮的会话 ID：重连降级与续发都靠它
    let conversationId = activeId.value;
    // 收到终帧（done / error）即本轮落定，此后不再重连
    let settled = false;

    const handlers = {
      onSeq: (seq: number) => {
        lastSeq = seq;
      },
      // 首个产出时后端即告知会话 ID：新建的会话从此刻起一定保留，
      // 先记下来，用户中途停止也还能接着这条会话继续发
      onConversation: (id: string) => {
        conversationId = id;
        activeId.value = id;
      },
      // done 事件由后端确认会话 ID，随后刷新列表以更新标题与排序
      onDone: async (id: string) => {
        settled = true;
        conversationId = id;
        activeId.value = id;
        await refreshConversations();
      },
      onError: (message: string) => {
        settled = true;
        errorMessage.value = message;
      },
    };

    /** 续传彻底失败时的降级：把会话在服务端的最终助手消息拉回来，避免界面停在半截 */
    const recoverConversation = async (): Promise<void> => {
      if (!conversationId) return;
      // 整段替换前先把缓冲落下：否则残留的增量会追到服务端全文之后，内容错位
      contentWriter.flush();
      try {
        const detail = await agentApi.getConversation(conversationId);
        const last = detail.messages.at(-1);
        // 服务端已落库的部分回复即本轮最终形态；比本地更全时以它为准
        if (last?.role === 'assistant' && last.content.length > assistant.value.content.length) {
          assistant.value.content = last.content;
        }
      } catch (error) {
        // 降级本身也会失效：令牌失效仍要收敛到登录页，其余错误不再叠加提示
        if (isUnauthorized(error)) await handleError(error);
      }
    };

    try {
      // 首次 POST：把提问发出去并开始消费流。
      // 网络层异常不致命——轮次可能已在服务端跑起来，交由随后的续传补齐
      try {
        await consumeChatStream(
          agentApi.streamChat(
            {
              conversationId: activeId.value ?? undefined,
              message: content,
              fileIds: ready.fileIds,
              roundId: currentRoundId,
            },
            currentController.signal,
          ),
          assistant.value,
          handlers,
          writes,
        );
      } catch (error) {
        if (isUnauthorized(error)) throw error;
        if (currentController.signal.aborted) return;
      }

      // 未收到终帧即视为断线：按退避重连续传，服务端从 lastSeq 之后重放
      for (const backoff of RECONNECT_DELAYS_MS) {
        if (settled || currentController.signal.aborted) break;
        await delay(backoff);
        if (settled || currentController.signal.aborted) break;
        try {
          await consumeChatStream(
            agentApi.resumeChat(currentRoundId, lastSeq, currentController.signal),
            assistant.value,
            handlers,
            writes,
          );
        } catch (error) {
          if (isUnauthorized(error)) throw error;
          if (currentController.signal.aborted) return;
          // 轮次已过期（404）：重连多少次都补不回来，跳出转降级
          if (isNotFound(error)) break;
        }
      }

      // 退避用尽或轮次已过期仍未落定：拉回服务端的最终内容兜底
      if (!settled && !currentController.signal.aborted) await recoverConversation();
    } catch (error) {
      // 用户主动中断不算错误；令牌失效同样经此收敛到登录页
      if (!currentController.signal.aborted) await handleError(error);
    } finally {
      // 收尾前把缓冲全部落下：合帧的最后一批增量不能丢，否则界面会停在第 N 帧
      contentWriter.flush();
      thinkingWriter.flush();
      streaming.value = false;
      controller = null;
      roundId = null;
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
    // 先通知服务端停止本轮生成：客户端断开只是退订，不通知的话它会继续在后台跑完
    if (roundId) void agentApi.stopRound(roundId).catch(() => undefined);
    controller?.abort();
    controller = null;
    roundId = null;
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
