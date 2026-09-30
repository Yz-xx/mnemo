<script setup lang="ts">
// catch-all 占位页：未实现的模块路由都落到此处。
// 随 P1-P4 各模块落地，对应路由会优先匹配到具体页面，此页仅兜底。
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const title = computed(() => `「${route.path}」功能开发中`);
</script>

<template>
  <div class="placeholder reveal" :style="{ '--reveal-index': 0 }">
    <p class="placeholder__tag">COMING SOON</p>
    <h2 class="placeholder__title">{{ title }}</h2>
    <p class="placeholder__desc">该模块将在后续迭代中实现，可先从左侧导航访问已上线的页面。</p>
  </div>
</template>

<style scoped lang="less">
.placeholder {
  padding: 56px 32px;
  background-color: var(--bg);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  text-align: center;

  &__tag {
    margin: 0 0 10px;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }

  &__title {
    margin: 0 0 8px;
    font-size: 18px;
    color: var(--text);
  }

  &__desc {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
  }
}
</style>
