<script setup lang="ts">
import { computed } from 'vue';
import type { ConnectionState } from '../composables/useChat';
import { useTheme } from '../composables/useTheme';
import type { AuthUser, ConversationSummary } from '../types';

// 主题是模块级单例状态，这里只负责读取与切换
const { theme, toggleTheme } = useTheme();

const props = defineProps<{
  conversations: ConversationSummary[];
  activeId: string | null;
  connection: ConnectionState;
  user: AuthUser | null;
}>();

const emit = defineEmits<{
  create: [];
  select: [id: string];
  remove: [id: string];
  settings: [];
  logout: [];
}>();

/** 头像用用户名首字，无需额外资源 */
const avatarText = computed(() => props.user?.username.slice(0, 1) ?? '?');

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  idle: '检测中',
  online: '已连接',
  offline: '未连接',
};

/** 会话列表按相对时间展示，减少视觉噪音 */
function formatTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(value).toLocaleDateString('zh-CN');
}
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
