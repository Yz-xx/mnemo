<script setup lang="ts">
// 批量操作条：展示已选条数，动作按钮由调用方经默认插槽提供。
// 各页的批量动作各不相同，这里只收敛出现时机与外观，避免四处各写一遍布局与样式。
import { X } from 'lucide-vue-next';

defineProps<{ count: number }>();

const emit = defineEmits<{ clear: [] }>();
</script>

<template>
  <div class="batch-bar">
    <span class="batch-bar__count">已选 {{ count }} 项</span>
    <div class="batch-bar__actions"><slot /></div>
    <button class="batch-bar__clear" type="button" @click="emit('clear')">
      <X :size="13" />
      <span>取消选择</span>
    </button>
  </div>
</template>

<style src="./BatchBar.less" lang="less" scoped></style>
