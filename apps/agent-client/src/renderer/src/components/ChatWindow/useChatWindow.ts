import type { ChatAttachment, ChatMessage, GeneratedFileInfo } from '../../types';
import type { Ref } from 'vue';
import { nextTick, ref, useTemplateRef, watch } from 'vue';

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

/** 距底部小于该距离时视为“跟随最新内容”，超出则说明用户正在上翻阅读 */
const FOLLOW_THRESHOLD = 80;

interface ChatWindowControls {
  draft: Ref<string>;
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
  // 滚动容器的模板 ref 归本组合式函数独占：组件只在模板写 ref="listRef"，
  // 脚本里不持有它，否则字符串 ref 会被 noUnusedLocals 判为「声明未读取」
  const listRef = useTemplateRef<HTMLElement>('listRef');
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

  return { draft, onScroll, submit, onKeydown };
}
