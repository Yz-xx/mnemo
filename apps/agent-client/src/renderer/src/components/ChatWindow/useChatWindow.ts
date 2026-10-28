import type { ChatAttachment, ChatMessage, GeneratedFileInfo } from '../../types';
import type { Ref } from 'vue';
import { onBeforeUnmount, ref } from 'vue';

/** ChatWindow 的入参：消息与流式状态由父级持有，本组件只渲染与上报 */
export interface ChatWindowProps {
  messages: ChatMessage[];
  streaming: boolean;
  canSend: boolean;
  errorMessage: string;
  model: string;
  provider: string;
  /** 待发送附件；为空表示本轮不带文件 */
  attachments: ChatAttachment[];
}

/** ChatWindow 的上抛事件：发送文本、停止流式与附件增删 */
export interface ChatWindowEmits {
  send: [text: string];
  stop: [];
  /** 请求打开系统文件对话框挑选附件 */
  attach: [];
  /** 移除某个待发送附件，参数为附件的本地临时 ID */
  removeAttachment: [key: string];
  /** 保存智能体生成的导出文件到本地 */
  download: [file: GeneratedFileInfo];
}

interface ChatWindowControls {
  draft: Ref<string>;
  /** 整段会话复制后的短暂反馈 */
  copied: Ref<boolean>;
  copyAll: () => Promise<void>;
  submit: () => void;
  onKeydown: (event: KeyboardEvent) => void;
}

/**
 * 输入条与整段复制：草稿、发送动作与「复制全部对话」都属于本组件的交互细节。
 * 滚动与窗口化在 `useVirtualMessages`，这里只在上抛发送后请求回到底部。
 */
export function useChatWindow(
  props: ChatWindowProps,
  emit: (event: 'send', text: string) => void,
  followToBottom: () => void,
): ChatWindowControls {
  const draft = ref('');

  // 复制反馈：按钮自身临时变成「已复制」，1.5 秒后回落到常态，不弹提示打断阅读
  const copied = ref(false);
  let copiedTimer: number | undefined;

  /**
   * 复制整段会话：窗口化后 Ctrl+F 与「全选复制」只能覆盖已挂载的消息，
   * 完整原文由这里提供，用户不必为了复制而一条条滚动。
   */
  async function copyAll(): Promise<void> {
    const text = props.messages
      .filter((message) => message.content.trim().length > 0)
      .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content.trim()}`)
      .join('\n\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用时保持原状：宁可没有反馈，也不谎报「已复制」
      return;
    }
    copied.value = true;
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  }

  onBeforeUnmount(() => {
    window.clearTimeout(copiedTimer);
  });

  function submit(): void {
    const text = draft.value.trim();
    if (!text || !props.canSend) return;
    emit('send', text);
    draft.value = '';
    // 主动发送时恢复跟随，确保新消息可见
    followToBottom();
  }

  /** Enter 发送，Shift + Enter 换行 */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return { draft, copied, copyAll, submit, onKeydown };
}
