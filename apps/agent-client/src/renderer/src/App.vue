<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import ChatWindow from './components/ChatWindow';
import LoginView from './components/LoginView';
import SessionSidebar from './components/SessionSidebar';
import SettingsDrawer from './components/SettingsDrawer';
import { useAuth } from './composables/useAuth';
import { useChat } from './composables/useChat';

const auth = useAuth();

// 顶层持有全部会话状态，子组件只负责渲染与事件上抛
const { backend, session, chat, attachments, lifecycle } = useChat();

const settingsVisible = ref(false);
// 启动时先校验本地令牌，期间不渲染主界面，避免闪出一份空的会话列表
const booting = ref(true);

// 登录态变化即切换数据源：登录后拉取该账号的会话，登出后清空以免串号
watch(
  () => auth.session.token,
  (token) => {
    if (token) void lifecycle.init();
    else lifecycle.reset();
  },
);

onMounted(async () => {
  await auth.session.restore();
  booting.value = false;
});
</script>

<template>
  <div v-if="booting" class="boot" />

  <LoginView v-else-if="!auth.session.token" />

  <div v-else class="shell">
    <SessionSidebar
      :conversations="session.conversations"
      :active-id="session.activeId"
      :connection="backend.connection"
      :user="auth.session.user"
      @create="session.startNewConversation"
      @select="session.selectConversation"
      @remove="session.removeConversation"
      @settings="settingsVisible = true"
      @logout="auth.session.logout"
    />

    <ChatWindow
      :messages="chat.messages"
      :streaming="chat.streaming"
      :can-send="chat.canSend"
      :error-message="chat.errorMessage"
      :model="backend.health?.model ?? ''"
      :provider="backend.health?.provider ?? ''"
      :attachments="attachments.list"
      @send="chat.sendMessage"
      @stop="chat.stopStreaming"
      @attach="attachments.add"
      @remove-attachment="attachments.remove"
      @download="chat.saveGeneratedFile"
    />

    <SettingsDrawer
      v-if="settingsVisible"
      :backend-url="backend.url"
      :health="backend.health"
      @close="settingsVisible = false"
      @save="backend.updateBackendUrl"
    />
  </div>
</template>

<style lang="less" scoped>
@import (reference) './styles/variables.less';

// 应用骨架：左侧会话栏固定宽度，右侧对话区自适应
.shell {
  display: grid;
  grid-template-columns: @sidebar-width 1fr;
  height: 100vh;
}

// 启动占位：校验本地令牌期间只保留窗口底色，不渲染任何界面
.boot {
  height: 100vh;
}
</style>
