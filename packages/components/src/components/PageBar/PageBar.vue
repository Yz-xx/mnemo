<script setup lang="ts">
// 分页条：提供上一页 / 下一页、页码信息与跳转到指定页，总页数由 total 与 pageSize 推出。
// 翻页通过 update:page 回传，重新取数由调用方负责。
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    page: number;
    pageSize: number;
    total: number;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{
  'update:page': [page: number];
}>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));

/** 目标页码收敛在 [1, totalPages]，越界点击不产生变化 */
function go(target: number): void {
  const next = Math.min(Math.max(target, 1), totalPages.value);
  if (!props.disabled && next !== props.page) emit('update:page', next);
}

/** 跳转输入框的原始文本：只有确认跳转才解析，避免用户输入中途就触发取数 */
const jumpText = ref('');

/** 跳转：空串与非整数一律忽略，越界交给 go 收敛到首尾页 */
function jump(): void {
  const raw = jumpText.value.trim();
  jumpText.value = '';
  if (raw === '') return;
  const target = Number(raw);
  if (Number.isInteger(target)) go(target);
}
</script>

<template>
  <div class="ui-page-bar">
    <span class="ui-page-bar__info">共 {{ total }} 条 · 第 {{ page }} / {{ totalPages }} 页</span>
    <button
      class="ui-page-bar__button"
      type="button"
      :disabled="disabled || page <= 1"
      @click="go(page - 1)"
    >
      上一页
    </button>
    <button
      class="ui-page-bar__button"
      type="button"
      :disabled="disabled || page >= totalPages"
      @click="go(page + 1)"
    >
      下一页
    </button>
    <span class="ui-page-bar__jump">
      <span class="ui-page-bar__jump-label">跳至</span>
      <input
        v-model="jumpText"
        class="ui-page-bar__input"
        type="text"
        inputmode="numeric"
        :disabled="disabled"
        :aria-label="`跳转到指定页，共 ${totalPages} 页`"
        @keyup.enter="jump"
      />
      <span class="ui-page-bar__jump-label">页</span>
      <button class="ui-page-bar__button" type="button" :disabled="disabled" @click="jump">
        跳转
      </button>
    </span>
  </div>
</template>

<style src="./PageBar.less" lang="less" scoped></style>
