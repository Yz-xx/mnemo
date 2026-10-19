<script setup lang="ts">
// 批量操作条：展示已选条数，动作按钮由调用方经默认插槽提供。
// 各页的批量动作各不相同，这里只收敛出现时机与外观，避免四处各写一遍布局与样式。
// 形态约定为「工具栏行内联」：消费方把它放进页面工具栏那一行，高度与搜索框、页面按钮齐平，
// 选中状态切换只改变该行的横向排布，行高不变，下方表格不会被推移。
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
