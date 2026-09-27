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
const {
  backendUrl,
  connection,
  health,
  conversations,
  activeId,
  messages,
  streaming,
  canSend,
  errorMessage,
  attachments,
  addAttachment,
  removeAttachment,
  init,
  reset,
  sendMessage,
  stopStreaming,
  startNewConversation,
  selectConversation,
  removeConversation,
  updateBackendUrl,
  saveGeneratedFile,
} = useChat();

const settingsVisible = ref(false);
// 启动时先校验本地令牌，期间不渲染主界面，避免闪出一份空的会话列表
const booting = ref(true);

// 登录态变化即切换数据源：登录后拉取该账号的会话，登出后清空以免串号
watch(
  () => auth.token.value,
  (token) => {
    if (token) void init();
    else reset();
  },
);

onMounted(async () => {
  await auth.restore();
  booting.value = false;
});
</script>

<template>
  <div v-if="booting" class="boot" />

  <LoginView v-else-if="!auth.token.value" />

  <div v-else class="shell">
    <SessionSidebar
      :conversations="conversations"
      :active-id="activeId"
      :connection="connection"
      :user="auth.user.value"
      @create="startNewConversation"
      @select="selectConversation"
      @remove="removeConversation"
      @settings="settingsVisible = true"
      @logout="auth.logout"
    />

    <ChatWindow
      :messages="messages"
      :streaming="streaming"
      :can-send="canSend"
      :error-message="errorMessage"
      :model="health?.model ?? ''"
      :provider="health?.provider ?? ''"
      :attachments="attachments"
      @send="sendMessage"
      @stop="stopStreaming"
      @attach="addAttachment"
      @remove-attachment="removeAttachment"
      @download="saveGeneratedFile"
    />

    <SettingsDrawer
      v-if="settingsVisible"
      :backend-url="backendUrl"
      :health="health"
      @close="settingsVisible = false"
      @save="updateBackendUrl"
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
