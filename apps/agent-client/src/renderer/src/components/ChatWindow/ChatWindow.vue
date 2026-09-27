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
      <MessageItem
        v-for="item in messages"
        :key="item.id"
        :message="item"
        @download="emit('download', $event)"
      />
    </div>

    <p v-if="errorMessage" class="chat__error">{{ errorMessage }}</p>

    <footer class="chat__foot">
      <div v-if="attachments.length > 0" class="composer__files">
        <span v-for="item in attachments" :key="item.key" class="chip chip--file">
          <span class="chip__name">{{ item.name }}</span>
          <span v-if="item.error" class="chip__state chip__state--error">{{ item.error }}</span>
          <span v-else-if="!item.fileId" class="chip__state">上传中</span>
          <button
            class="chip__remove"
            type="button"
            title="移除附件"
            @click="emit('removeAttachment', item.key)"
          >
            ×
          </button>
        </span>
      </div>

      <!-- 输入条分两层：上面写正文，下面一条操作行；写与发因此不再挤在同一行 -->
      <div class="composer">
        <textarea
          v-model="draft"
          class="composer__input"
          rows="2"
          placeholder="输入消息，Enter 发送，Shift + Enter 换行"
          :disabled="!canSend"
          @keydown="onKeydown"
        />
        <div class="composer__bar">
          <button
            class="composer__attach"
            type="button"
            title="添加附件"
            :disabled="!canSend"
            @click="emit('attach')"
          >
            <svg
              class="composer__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
              />
            </svg>
            <span>附件</span>
          </button>
          <!-- 发送与停止共用一个圆形钮位：右侧只有一个「当前动作」，不会出现两个并列的按钮 -->
          <button
            v-if="streaming"
            class="composer__send composer__send--stop"
            type="button"
            title="停止生成"
            aria-label="停止生成"
            @click="emit('stop')"
          >
            <svg class="composer__icon" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
          <button
            v-else
            class="composer__send"
            type="button"
            title="发送"
            aria-label="发送"
            :disabled="!canSend || !draft.trim()"
            @click="submit"
          >
            <svg
              class="composer__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </footer>
  </main>
</template>

<style src="./ChatWindow.less" lang="less" scoped></style>
