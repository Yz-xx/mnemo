<script setup lang="ts">
import { useSessionSidebar } from './useSessionSidebar';
import type { SessionSidebarEmits, SessionSidebarProps } from './useSessionSidebar';

const props = defineProps<SessionSidebarProps>();

const emit = defineEmits<SessionSidebarEmits>();

const { theme, toggleTheme, avatarText, formatTime, CONNECTION_TEXT } = useSessionSidebar(props);
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__head">
      <span class="sidebar__brand">AI Agent</span>
      <button class="icon-btn" title="新建对话" @click="emit('create')">＋</button>
    </div>

    <ul class="session-list">
      <li
        v-for="item in conversations"
        :key="item.id"
        class="session"
        :class="{ 'session--active': item.id === activeId }"
        @click="emit('select', item.id)"
      >
        <div class="session__title">{{ item.title }}</div>
        <div class="session__meta">
          {{ formatTime(item.updatedAt) }} · {{ item.messageCount }} 条
        </div>
        <button class="session__remove" title="删除会话" @click.stop="emit('remove', item.id)">
          ×
        </button>
      </li>
    </ul>

    <p v-if="conversations.length === 0" class="sidebar__empty">暂无历史会话</p>

    <div class="sidebar__user">
      <span class="sidebar__avatar">{{ avatarText }}</span>
      <span class="sidebar__name">{{ user?.username }}</span>
      <button class="sidebar__logout" title="退出登录" @click="emit('logout')">退出</button>
    </div>

    <div class="sidebar__foot">
      <span class="dot" :class="`dot--${connection}`" />
      <span class="sidebar__status">{{ CONNECTION_TEXT[connection] }}</span>
      <button
        class="icon-btn"
        :title="theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'"
        @click="toggleTheme"
      >
        {{ theme === 'dark' ? '☀' : '☾' }}
      </button>
      <button class="icon-btn" title="设置" @click="emit('settings')">⚙</button>
    </div>
  </aside>
</template>

<style src="./SessionSidebar.less" lang="less" scoped></style>
