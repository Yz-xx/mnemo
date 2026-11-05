<script setup lang="ts">
import type { ChatCitation } from '../../types';
import { computed, ref, toRef } from 'vue';
import { useCitationDrawer } from './useCitationDrawer';

const props = defineProps<{ citation: ChatCitation }>();

const emit = defineEmits<{ close: [] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const { kind, loading, errorMessage, segments, pageNumber, pageCount, changePage } =
  useCitationDrawer(toRef(props, 'citation'), canvas);

/** 状态文案合并成一处：加载、失败与不支持的格式都只占同一块区域 */
const stateText = computed(() => {
  if (loading.value) return '正在读取原文…';
  if (errorMessage.value) return errorMessage.value;
  return kind.value === 'unsupported' ? '该格式暂不支持在线预览' : '';
});
</script>

<template>
  <div class="citation">
    <div class="citation__panel">
      <header class="citation__head">
        <div class="citation__meta">
          <p class="citation__title">{{ citation.title }}</p>
          <p class="citation__position">
            {{ citation.page ? `第 ${citation.page} 页` : '文本片段' }}
          </p>
        </div>
        <button class="citation__close" type="button" title="关闭" @click="emit('close')">×</button>
      </header>

      <div
        v-if="stateText"
        class="citation__state"
        :class="{ 'citation__state--error': !!errorMessage }"
      >
        {{ stateText }}
      </div>

      <!-- 文本类全文按摘要命中切段：命中处用软金底标出，命中不到就不高亮 -->
      <div v-else-if="kind === 'text'" class="citation__text">
        <template v-for="(segment, index) in segments" :key="index">
          <mark v-if="segment.highlighted">{{ segment.text }}</mark>
          <span v-else>{{ segment.text }}</span>
        </template>
      </div>

      <div v-else-if="kind === 'pdf'" class="citation__pdf">
        <div class="citation__pager">
          <button type="button" :disabled="pageNumber <= 1" @click="changePage(-1)">上一页</button>
          <span class="citation__page">{{ pageNumber }} / {{ pageCount }}</span>
          <button type="button" :disabled="pageNumber >= pageCount" @click="changePage(1)">
            下一页
          </button>
        </div>
        <div class="citation__canvas-wrap">
          <canvas ref="canvas" class="citation__canvas" />
        </div>
      </div>
    </div>

    <div class="citation__mask" @click="emit('close')" />
  </div>
</template>

<style src="./CitationDrawer.less" lang="less" scoped></style>
