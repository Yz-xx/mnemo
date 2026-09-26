import { nextTick, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { ChatMessage } from '../../types';

/** ChatWindow 的入参：消息与流式状态由父级持有，本组件只渲染与上报 */
export interface ChatWindowProps {
  messages: ChatMessage[];
  streaming: boolean;
  canSend: boolean;
  errorMessage: string;
  model: string;
  provider: string;
}

/** ChatWindow 的上抛事件：发送文本与停止流式 */
export interface ChatWindowEmits {
  send: [text: string];
  stop: [];
}

/** 距底部小于该距离时视为“跟随最新内容”，超出则说明用户正在上翻阅读 */
const FOLLOW_THRESHOLD = 80;

interface ChatWindowControls {
  draft: Ref<string>;
  listRef: Ref<HTMLElement | null>;
  onScroll: () => void;
  submit: () => void;
  onKeydown: (event: KeyboardEvent) => void;
}

/** 输入条与滚动跟随：草稿、跟随判定和发送动作都属于本组件的交互细节 */
export function useChatWindow(
  props: ChatWindowProps,
  emit: (event: 'send', text: string) => void,
): ChatWindowControls {
  const draft = ref('');
  const listRef = ref<HTMLElement | null>(null);
  const following = ref(true);

  function onScroll(): void {
    const list = listRef.value;
    if (!list) return;
    following.value = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_THRESHOLD;
  }

  // 监听全部消息文本长度，覆盖“新增消息”与“流式追加”两种情况
  watch(
    () => props.messages.reduce((total, item) => total + item.content.length, 0),
    async () => {
      await nextTick();
      const list = listRef.value;
      // 用户主动上翻查看历史时不强行拉回底部
      if (list && following.value) list.scrollTop = list.scrollHeight;
    },
  );

  function submit(): void {
    const text = draft.value.trim();
    if (!text || !props.canSend) return;
    emit('send', text);
    draft.value = '';
    // 主动发送时恢复跟随，确保新消息可见
    following.value = true;
  }

  /** Enter 发送，Shift + Enter 换行 */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return { draft, listRef, onScroll, submit, onKeydown };
}
