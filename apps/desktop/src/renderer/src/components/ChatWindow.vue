<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import MessageItem from './MessageItem.vue';
import type { ChatMessage } from '../types';

const props = defineProps<{
  messages: ChatMessage[];
  streaming: boolean;
  canSend: boolean;
  errorMessage: string;
  model: string;
  provider: string;
}>();

const emit = defineEmits<{
  send: [text: string];
  stop: [];
}>();

const draft = ref('');
const listRef = ref<HTMLElement | null>(null);
// 距底部小于该距离时视为“跟随最新内容”，超出则说明用户正在上翻阅读
const FOLLOW_THRESHOLD = 80;
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
</script>

<template>
  <main class="chat">
    <header class="chat__head">
      <span class="chat__model">{{ model || '未连接后端' }}</span>
      <span v-if="provider" class="chip chip--muted">{{ provider }}</span>
    </header>

    <div ref="listRef" class="chat__list" @scroll="onScroll">
      <div v-if="messages.length === 0" class="chat__placeholder">
        <p class="chat__placeholder-title">开始一段对话</p>
        <p class="chat__placeholder-text">智能体会按需调用工具与知识库。</p>
      </div>
      <MessageItem v-for="item in messages" :key="item.id" :message="item" />
    </div>

    <p v-if="errorMessage" class="chat__error">{{ errorMessage }}</p>

    <footer class="chat__foot">
      <div class="composer">
        <textarea
          v-model="draft"
          class="composer__input"
          rows="2"
          placeholder="输入消息，Enter 发送，Shift + Enter 换行"
          :disabled="!canSend"
          @keydown="onKeydown"
        />
        <button v-if="streaming" class="btn btn--danger" @click="emit('stop')">停止</button>
        <button
          v-else
          class="btn btn--primary"
          :disabled="!canSend || !draft.trim()"
          @click="submit"
        >
          发送
        </button>
      </div>
    </footer>
  </main>
</template>
