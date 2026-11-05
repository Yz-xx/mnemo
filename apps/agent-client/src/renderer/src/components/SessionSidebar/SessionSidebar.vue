<script setup lang="ts">
import type { SessionSidebarEmits, SessionSidebarProps } from './useSessionSidebar';
import { useSessionSidebar } from './useSessionSidebar';

const props = defineProps<SessionSidebarProps>();

const emit = defineEmits<SessionSidebarEmits>();

const {
  theme,
  toggleTheme,
  avatarText,
  formatTime,
  baseName,
  editingId,
  draftTitle,
  startRename,
  submitRename,
  cancelRename,
  finishRename,
  CONNECTION_TEXT,
} = useSessionSidebar(props, emit);
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__head">
      <span class="sidebar__brand">AI Agent</span>
      <button class="icon-btn" title="新建对话" @click="emit('create')">＋</button>
    </div>

    <!-- 知识库入口：管理库与文档的一等入口，不再只藏在设置抽屉里 -->
    <button class="sidebar__knowledge" type="button" @click="emit('knowledge')">
      <span>知识库管理</span>
      <span class="sidebar__knowledge-arrow">→</span>
    </button>

    <ul class="session-list">
      <li
        v-for="item in conversations"
        :key="item.id"
        class="session"
        :class="{ 'session--active': item.id === activeId }"
        @click="emit('select', item.id)"
      >
        <!-- 重命名就地编辑：避免弹窗打断浏览，Enter 提交、Esc 取消、失焦收尾 -->
        <input
          v-if="editingId === item.id"
          v-model="draftTitle"
          class="session__rename"
          :maxlength="24"
          @click.stop
          @keydown.enter.prevent="submitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="finishRename"
        />
        <div v-else class="session__title">{{ item.title }}</div>
        <div v-if="item.knowledgeBaseId" class="session__meta">
          <span class="session__base">{{ baseName(item.knowledgeBaseId) }}</span>
          <span>· {{ formatTime(item.updatedAt) }} · {{ item.messageCount }} 条</span>
        </div>
        <div v-else class="session__meta">
          {{ formatTime(item.updatedAt) }} · {{ item.messageCount }} 条
        </div>
        <button
          v-if="editingId !== item.id"
          class="session__action"
          title="重命名会话"
          @click.stop="startRename(item)"
        >
          ✎
        </button>
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
