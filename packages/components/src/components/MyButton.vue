<script setup lang="ts">
// 组件库示例按钮：支持主题类型与禁用状态，点击时向父级派发 click 事件
interface Props {
  /** 按钮主题类型 */
  type?: 'default' | 'primary' | 'danger';
  /** 是否禁用 */
  disabled?: boolean;
}

withDefaults(defineProps<Props>(), {
  type: 'default',
  disabled: false,
});

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void;
}>();

function handleClick(event: MouseEvent) {
  emit('click', event);
}
</script>

<template>
  <button class="my-button" :class="`my-button--${type}`" :disabled="disabled" @click="handleClick">
    <slot>按钮</slot>
  </button>
</template>

<style scoped>
.my-button {
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid #dcdfe6;
  background: #fff;
  cursor: pointer;
  transition: all 0.2s ease;
}

.my-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.my-button--primary {
  border-color: #409eff;
  background: #409eff;
  color: #fff;
}

.my-button--danger {
  border-color: #f56c6c;
  background: #f56c6c;
  color: #fff;
}
</style>
