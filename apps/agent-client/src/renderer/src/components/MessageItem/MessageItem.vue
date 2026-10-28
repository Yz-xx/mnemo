<script setup lang="ts">
import type { ChatMessage, ChatStep, GeneratedFileInfo } from '../../types';
import { computed, onBeforeUpdate, onUpdated, ref, watch } from 'vue';
import { beginDomUpdate, measureRender } from '../../perf/renderMetrics';
import { renderBlocks } from './markdown';

/** 工具标签文案：有 detail 时用后端给的人话，缺省（历史回看）时退回工具名 */
function stepLabel(step: ChatStep): string {
  if (!step.detail) return step.running ? `调用工具 ${step.name}` : `完成 ${step.name}`;
  return step.running ? `正在${step.detail}` : `已完成 ${step.detail}`;
}

const props = defineProps<{ message: ChatMessage }>();

/** 生成的文件由上层负责取字节并落盘，本组件只上报点击 */
const emit = defineEmits<{ download: [file: GeneratedFileInfo] }>();

// 去掉首尾空白，规避模型首个 token 为换行时出现的顶部空行
const content = computed(() => props.message.content.trim());
const isAssistant = computed(() => props.message.role === 'assistant');
// 按顶层块切分渲染：未变化的块 HTML 保持逐字相同，交给 v-for 的 key 复用 DOM，
// 流式增量只重建正在增长的末块（见 ADR 0016 阶段 2）；解析计时只做测量、不改行为
const renderedBlocks = computed(() => measureRender(() => renderBlocks(content.value)));

// DOM 更新时间单独量：v-html 重建节点的开销落在渲染管线里，不在上面那段解析窗口内，
// 阶段 0 的 long task 全为 0 正说明这段没被覆盖（见 ADR 0016 阶段 1）
let endDomUpdate: () => void = () => {};
onBeforeUpdate(() => {
  endDomUpdate = beginDomUpdate();
});
onUpdated(() => {
  endDomUpdate();
  endDomUpdate = () => {};
});

// 思考过程面板默认展开跟随推理输出；正文首个 token 到达即自动折叠——
// thinking 与正文可能交错出现，不折叠会让界面反复跳动
const thinkingExpanded = ref(true);
watch(
  () => content.value.length > 0,
  (hasContent) => {
    if (hasContent) thinkingExpanded.value = false;
  },
);

// 上下文治理提示：服务端只在真的裁掉历史时下发，历史回看时缺省。
// 摘要版与直接丢弃版分开说，用户才知道那段历史是被压缩还是被丢掉
const contextHint = computed(() => {
  const context = props.message.context;
  if (!context) return '';
  const count = `${context.trimmedMessages} 条更早的对话`;
  return context.summarized ? `已将 ${count}压缩为摘要` : `已丢弃 ${count}`;
});

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
      <!-- 模型推理链：排在正文之前，正文首个 token 到达时自动收起（见 thinkingExpanded）。
           历史回看时服务端不落库该字段，面板整块不渲染 -->
      <div v-if="isAssistant && message.thinking" class="message__thinking">
        <button
          class="message__thinking-toggle"
          type="button"
          :aria-expanded="thinkingExpanded"
          @click="thinkingExpanded = !thinkingExpanded"
        >
          <svg
            class="message__thinking-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
          思考过程
        </button>
        <div v-show="thinkingExpanded" class="message__thinking-body">{{ message.thinking }}</div>
      </div>
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
      <!-- 按顶层块逐块渲染：内容未变的块 HTML 字符串相同，Vue 依赖 key 复用其 DOM，
           流式增量只重建最后一块，不再整篇重排 -->
      <div v-else class="message__content markdown">
        <div
          v-for="(block, index) in renderedBlocks"
          :key="index"
          class="markdown__block"
          v-html="block"
        />
      </div>
      <!-- 本轮提问附带的文件：回看这条消息时能看出回答是基于哪些文件 -->
      <div v-if="message.attachments?.length" class="message__files">
        <span v-for="name in message.attachments" :key="name" class="chip">{{ name }}</span>
      </div>
      <!-- 上下文治理痕迹：只在服务端真的裁掉历史时渲染（历史回看时不还原） -->
      <div v-if="isAssistant && contextHint" class="message__context">
        <span class="chip chip--context">{{ contextHint }}</span>
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
          {{ stepLabel(step) }}
        </span>
      </div>
      <!-- 本轮实际采用的来源文档：工具结束后先推已注入的文档，流末尾再由服务端按正文标注覆盖；
           正文一处都没标注时终局清单为空，检索到但没采用的文档不显示出处 -->
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
