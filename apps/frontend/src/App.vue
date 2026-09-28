<script setup lang="ts">
// 根组件：布局分发器。login 页的 <route> 块设 meta.layout='blank'，独立渲染；
// 其余页套 AdminLayout（其内部 <router-view/> 渲染当前路由组件）。
// App.vue 保持单文件形态（见 code-style 第 4 节根组件例外），不掺业务逻辑。
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AdminLayout from '@/layouts/AdminLayout.vue';

const route = useRoute();
const isBlank = computed(() => route.meta.layout === 'blank');
</script>

<template>
  <AdminLayout v-if="!isBlank" />
  <router-view v-else />
</template>
