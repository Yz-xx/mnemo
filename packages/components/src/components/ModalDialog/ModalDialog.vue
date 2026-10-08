<script setup lang="ts">
// 通用弹窗：遮罩 + 卡片 + 标题栏 + 内容插槽 + 底部按钮。
// 关闭方式（点遮罩、Esc、右上角 ×）与请求中的锁定都收在这里，
// 调用方只需给内容与 confirm 事件，不必各自复刻遮罩、按钮与关闭逻辑。
// 关闭图标经具名插槽 close-icon 由消费方传入：组件库不自带图标依赖。
import { onBeforeUnmount, onMounted } from 'vue';

const props = withDefaults(
  defineProps<{
    title: string;
    /** 卡片宽度 */
    width?: string;
    confirmText?: string;
    /** 取消按钮文案；为 null 时不渲染，供只有一个关闭动作的详情类弹窗使用 */
    cancelText?: string | null;
    /** 确认按钮走危险色：用于删除一类不可逆操作 */
    danger?: boolean;
    /** 请求进行中：按钮置灰并屏蔽关闭，避免中途关掉弹窗导致调用方拿不到结果 */
    loading?: boolean;
  }>(),
  { width: '420px', confirmText: '确认', cancelText: '取消', danger: false, loading: false },
);

const emit = defineEmits<{ close: []; confirm: [] }>();

function requestClose(): void {
  if (!props.loading) emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') requestClose();
}

// 监听 window 而非弹窗元素：焦点不在弹窗内时 Esc 同样生效
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="ui-modal">
    <div class="ui-modal__mask" @click="requestClose" />
    <div class="ui-modal__card" :style="{ width }" role="dialog" aria-modal="true">
      <header class="ui-modal__head">
        <h2 class="ui-modal__title">{{ title }}</h2>
        <button class="ui-modal__close" type="button" title="关闭" @click="requestClose">
          <slot name="close-icon" />
        </button>
      </header>
      <div class="ui-modal__body"><slot /></div>
      <footer class="ui-modal__foot">
        <button
          v-if="cancelText !== null"
          class="ui-modal__button"
          type="button"
          :disabled="loading"
          @click="requestClose"
        >
          {{ cancelText }}
        </button>
        <button
          class="ui-modal__button"
          :class="danger ? 'ui-modal__button--danger' : 'ui-modal__button--primary'"
          type="button"
          :disabled="loading"
          @click="emit('confirm')"
        >
          {{ loading ? '处理中…' : confirmText }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style src="./ModalDialog.less" lang="less" scoped></style>
