<script setup lang="ts">
import { ref } from 'vue';
import { capitalize } from '@repo/shared';
import { MyButton } from '@repo/components';

// 演示跨包复用：shared 工具函数 + components 组件
const message = ref(capitalize('hello monorepo'));
const clickCount = ref(0);

function handleClick() {
  clickCount.value += 1;
}
</script>

<template>
  <main class="app">
    <h1>{{ message }}</h1>
    <p>组件库按钮点击次数：{{ clickCount }}</p>
    <MyButton type="primary" @click="handleClick">点我 +1</MyButton>
  </main>
</template>

<style scoped>
.app {
  max-width: 720px;
  margin: 80px auto;
  text-align: center;
  font-family: system-ui, sans-serif;
}
</style>
