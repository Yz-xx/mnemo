<script setup lang="ts">
import MessageItem from '../MessageItem';
import { useChatWindow } from './useChatWindow';
import type { ChatWindowEmits, ChatWindowProps } from './useChatWindow';

const props = defineProps<ChatWindowProps>();

const emit = defineEmits<ChatWindowEmits>();

const { draft, listRef, onScroll, submit, onKeydown } = useChatWindow(props, emit);
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

<style src="./ChatWindow.less" lang="less" scoped></style>
