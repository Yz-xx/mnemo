<script setup lang="ts">
import type { ChatCitation, MessageSource } from '../../types';
import { canPreview, sourceHint, sourceKey, sourceTitle } from './sources';

const props = defineProps<{ sources: MessageSource[] }>();

const emit = defineEmits<{ preview: [citation: ChatCitation] }>();

/** 旧版纯文本来源不可点：给出一个点了没反应的入口比不给更差 */
function open(source: MessageSource): void {
  if (canPreview(source)) emit('preview', source);
}
</script>

<template>
  <div class="message__sources">
    <button
      v-for="(source, index) in props.sources"
      :key="sourceKey(source, index)"
      class="chip chip--source"
      :class="{ 'chip--source-static': !canPreview(source) }"
      type="button"
      :title="sourceHint(source)"
      :disabled="!canPreview(source)"
      @click="open(source)"
    >
      <!-- 序号角标只给可定位的引用：旧版来源点了也没反应，角标会误导成跳转入口 -->
      <span v-if="canPreview(source)" class="chip__index">{{ index + 1 }}</span>
      <span class="chip__name">{{ sourceTitle(source) }}</span>
      <span v-if="canPreview(source) && source.page" class="chip__page">
        第 {{ source.page }} 页
      </span>
    </button>
  </div>
</template>

<style src="./SourceChips.less" lang="less" scoped></style>
