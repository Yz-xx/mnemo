<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import type { ChatMessage } from '../types';

const props = defineProps<{ message: ChatMessage }>();

// 单例实例：关闭原始 HTML，避免模型输出中的标签被直接注入渲染
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

// 链接一律标记为外部打开，交由主进程的 setWindowOpenHandler 用系统浏览器处理
markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet('target', '_blank');
  return self.renderToken(tokens, index, options);
};

// 去掉首尾空白，规避模型首个 token 为换行时出现的顶部空行
const content = computed(() => props.message.content.trim());
const isAssistant = computed(() => props.message.role === 'assistant');
const rendered = computed(() => markdown.render(content.value));
</script>

<template>
  <div class="message" :class="`message--${message.role}`">
    <div class="message__avatar">{{ message.role === 'user' ? '我' : 'AI' }}</div>
    <div class="message__body">
      <!-- 等待首个 token 时用三点脉冲示意工作状态 -->
      <div
        v-if="!content"
        class="message__content message__content--pending"
        role="status"
        aria-label="正在思考"
      >
        <span class="thinking-dot" />
        <span class="thinking-dot" />
        <span class="thinking-dot" />
      </div>
      <!-- 用户输入按纯文本展示，避免其输入的符号被当作 Markdown 语法解析 -->
      <div v-else-if="!isAssistant" class="message__content">{{ content }}</div>
      <div v-else class="message__content markdown" v-html="rendered" />
      <!-- 工具调用记录属于“过程信息”，排在正文之后，避免正文首行被顶下去 -->
      <div v-if="message.steps?.length" class="message__steps">
        <span v-for="step in message.steps" :key="step" class="chip">{{ step }}</span>
      </div>
    </div>
  </div>
</template>
