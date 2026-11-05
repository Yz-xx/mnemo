import type {
  ChatAttachment,
  ChatMessage,
  GeneratedFileInfo,
  KnowledgeBaseView,
} from '../../types';
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
  /** 可绑定的知识库：新会话可选，默认「不限库」沿旧行为 */
  knowledgeBases: KnowledgeBaseView[];
  /** 新会话将绑定的库：null 表示不限库 */
  selectedKnowledgeBaseId: string | null;
  /** 已打开会话的绑定库：有值时只读展示，不再允许改绑 */
  boundKnowledgeBaseId: string | null;
}

/** ChatWindow 的上抛事件：发送文本、停止流式、附件增删与选择知识库 */
export interface ChatWindowEmits {
  send: [text: string];
  stop: [];
  /** 请求打开系统文件对话框挑选附件 */
  attach: [];
  /** 移除某个待发送附件，参数为附件的本地临时 ID */
  removeAttachment: [key: string];
  /** 保存智能体生成的导出文件到本地 */
  download: [file: GeneratedFileInfo];
  /** 选择新会话的知识库：null 表示不限库 */
  selectKnowledgeBase: [id: string | null];
}

/**
 * 判断这次按键是否应当触发发送。
 * 输入法组合期间的 Enter 只用于确认候选词，若当作发送会把未完成的候选词发出去；
 * 事件类型收窄为判定所需的三项，便于直接测试规则本身。
 */
export function isSendEnter(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing'>,
): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

interface ChatWindowControls {
  draft: Ref<string>;
  /** 整段会话复制后的短暂反馈 */
  copied: Ref<boolean>;
  copyAll: () => Promise<void>;
  submit: () => void;
  onKeydown: (event: KeyboardEvent) => void;
  /** 绑定库的展示名：库被删除时给出明确文案 */
  baseName: (id: string) => string;
  onBaseChange: (event: Event) => void;
}

/**
 * 输入条、整段复制与知识库选择：草稿、发送动作都属于本组件的交互细节。
 * 滚动与窗口化在 `useVirtualMessages`，这里只在上抛发送后请求回到底部。
 */
export function useChatWindow(
  props: ChatWindowProps,
  emit: <K extends keyof ChatWindowEmits>(event: K, ...args: ChatWindowEmits[K]) => void,
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

  function onKeydown(event: KeyboardEvent): void {
    if (!isSendEnter(event)) return;
    event.preventDefault();
    submit();
  }

  function baseName(id: string): string {
    return props.knowledgeBases.find((base) => base.id === id)?.name ?? '已删除的知识库';
  }

  /** 下拉选择：空值即「不限库」，与不传 knowledgeBaseId 的服务端语义一致 */
  function onBaseChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    emit('selectKnowledgeBase', value || null);
  }

  return { draft, copied, copyAll, submit, onKeydown, baseName, onBaseChange };
}
