<script setup lang="ts">
// 批量操作条：展示已选条数，动作按钮由调用方经默认插槽提供。
// 各页的批量动作各不相同，这里只收敛出现时机与外观，避免四处各写一遍布局与样式。
// 取消选择图标经具名插槽 clear-icon 由消费方传入：组件库不自带图标依赖。
defineProps<{ count: number }>();

const emit = defineEmits<{ clear: [] }>();
</script>

<template>
  <div class="ui-batch-bar">
    <span class="ui-batch-bar__count">已选 {{ count }} 项</span>
    <div class="ui-batch-bar__actions"><slot /></div>
    <button class="ui-batch-bar__clear" type="button" @click="emit('clear')">
      <slot name="clear-icon" />
      <span>取消选择</span>
    </button>
  </div>
</template>

<style src="./BatchBar.less" lang="less" scoped></style>
