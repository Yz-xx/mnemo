<script setup lang="ts">
import type { ChatMessage, GeneratedFileInfo } from '../../types';
import MarkdownIt from 'markdown-it';
import { computed, ref } from 'vue';

const props = defineProps<{ message: ChatMessage }>();

/** 生成的文件由上层负责取字节并落盘，本组件只上报点击 */
const emit = defineEmits<{ download: [file: GeneratedFileInfo] }>();

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

// 复制反馈：按钮自身临时变成对勾，1.5 秒后回落到常态，不弹提示打断阅读
const copied = ref(false);
let copiedTimer: number | undefined;

async function copyContent() {
  try {
    await navigator.clipboard.writeText(content.value);
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
</script>

<template>
  <div class="message" :class="`message--${message.role}`">
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
      <!-- 本轮提问附带的文件：回看这条消息时能看出回答是基于哪些文件 -->
      <div v-if="message.attachments?.length" class="message__files">
        <span v-for="name in message.attachments" :key="name" class="chip">{{ name }}</span>
      </div>
      <!-- 工具调用记录属于“过程信息”，排在正文之后，避免正文首行被顶下去 -->
      <div v-if="message.steps?.length" class="message__steps">
        <!-- 执行中的标签带一枚转圈：工具等待结果时不会看起来像卡住 -->
        <span
          v-for="(step, index) in message.steps"
          :key="`${step.name}-${index}`"
          class="chip"
          :class="{ 'chip--running': step.running }"
        >
          <span v-if="step.running" class="chip__spinner" aria-hidden="true" />
          {{ step.running ? `调用工具 ${step.name}` : `完成 ${step.name}` }}
        </span>
      </div>
      <!-- 本轮检索命中的知识库文档：由服务端在检索工具结束后确定地推来，
           不指望模型在正文里标注出处（提示词早有要求，但小模型遵循率撑不起主链路） -->
      <div v-if="message.sources?.length" class="message__sources">
        <span v-for="name in message.sources" :key="name" class="chip chip--source">
          来源《{{ name }}》
        </span>
      </div>
      <!-- 智能体生成的导出文件：点一下就能存到本地，是这条回复的“交付物” -->
      <div v-if="message.files?.length" class="message__files">
        <button
          v-for="file in message.files"
          :key="file.fileId"
          class="chip chip--download"
          type="button"
          :title="`保存 ${file.name}`"
          @click="emit('download', file)"
        >
          {{ file.name }}
        </button>
      </div>
      <!-- 操作行：常驻会让每条回复都拖出一排图标，只在指针进入这条消息时出现 -->
      <div v-if="isAssistant && content" class="message__actions">
        <button
          class="message__action"
          type="button"
          :title="copied ? '已复制' : '复制'"
          :aria-label="copied ? '已复制' : '复制回复内容'"
          @click="copyContent"
        >
          <svg
            v-if="copied"
            class="message__action-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
          <svg
            v-else
            class="message__action-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="11" height="11" rx="2.5" />
            <path d="M6.5 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v.5" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style src="./MessageItem.less" lang="less" scoped></style>
