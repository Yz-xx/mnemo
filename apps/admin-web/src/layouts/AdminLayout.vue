<script setup lang="ts">
// 管理后台主布局：顶栏 + 侧边栏 + 内容区。
// 路由驱动的页面在 <router-view/> 渲染；login 页不经此布局（App.vue 按 meta.layout 分流）。
// 导航清单与激活判定抽在 navigation.ts：本组件只负责排版与登出。
import { LogOut, Menu } from 'lucide-vue-next';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { isItemActive, NAV_GROUPS, resolveTitle } from './navigation';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const collapsed = ref(false);

// 当前页标题：用于顶栏展示
const currentTitle = computed(() => resolveTitle(route.path));

async function handleLogout(): Promise<void> {
  await auth.logout();
  await router.push('/login');
}
</script>

<template>
  <div class="admin-layout">
    <aside class="admin-layout__sidebar" :class="{ 'admin-layout__sidebar--collapsed': collapsed }">
      <div class="admin-layout__brand">
        <span class="admin-layout__brand-mark">AC</span>
        <span class="admin-layout__brand-text">
          <span class="admin-layout__brand-title">智能体管理</span>
          <span class="admin-layout__brand-sub">AGENT CONSOLE</span>
        </span>
      </div>
      <nav class="admin-layout__nav">
        <div v-for="group in NAV_GROUPS" :key="group.title" class="admin-layout__nav-group">
          <p class="admin-layout__nav-title">{{ group.title }}</p>
          <router-link
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="admin-layout__nav-item"
            :class="{ 'admin-layout__nav-item--active': isItemActive(item.path, route.path) }"
          >
            <component :is="item.icon" :size="16" class="admin-layout__nav-icon" />
            <span class="admin-layout__nav-label">{{ item.label }}</span>
          </router-link>
        </div>
      </nav>
    </aside>
    <div class="admin-layout__main">
      <header class="admin-layout__header">
        <button
          class="admin-layout__toggle"
          :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="collapsed = !collapsed"
        >
          <Menu :size="18" />
        </button>
        <h1 class="admin-layout__title">{{ currentTitle }}</h1>
        <span class="admin-layout__tag">ADMIN</span>
        <div class="admin-layout__user">
          <span class="admin-layout__username">{{ auth.user?.username ?? '未登录' }}</span>
          <button class="admin-layout__logout" @click="handleLogout">
            <LogOut :size="14" />
            <span>退出</span>
          </button>
        </div>
      </header>
      <main class="admin-layout__content">
        <router-view />
      </main>
    </div>
  </div>
</template>

<style src="./AdminLayout.less" lang="less" scoped></style>
