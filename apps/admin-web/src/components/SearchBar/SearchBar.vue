<script setup lang="ts">
// 关键词搜索条：输入即同步 v-model:keyword，回车或点「查询」触发 search。
// 组件不感知查询条件本身，过滤逻辑留在调用方；插槽用于放「新建」一类的页面级操作。
import { Search } from 'lucide-vue-next';

withDefaults(defineProps<{ keyword: string; placeholder?: string }>(), {
  placeholder: '输入关键词',
});

const emit = defineEmits<{
  'update:keyword': [value: string];
  search: [];
}>();
</script>

<template>
  <div class="search-bar">
    <div class="search-bar__field">
      <Search :size="15" class="search-bar__icon" />
      <input
        class="search-bar__input"
        type="search"
        :value="keyword"
        :placeholder="placeholder"
        @input="emit('update:keyword', ($event.target as HTMLInputElement).value)"
        @keyup.enter="emit('search')"
      />
    </div>
    <button class="search-bar__button" type="button" @click="emit('search')">查询</button>
    <slot />
  </div>
</template>

<style src="./SearchBar.less" lang="less" scoped></style>
