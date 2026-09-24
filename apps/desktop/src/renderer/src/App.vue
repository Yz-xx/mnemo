<script setup lang="ts">
import { onMounted, ref } from 'vue';
import ChatWindow from './components/ChatWindow.vue';
import SessionSidebar from './components/SessionSidebar.vue';
import SettingsDrawer from './components/SettingsDrawer.vue';
import { useChat } from './composables/useChat';

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
  init,
  sendMessage,
  stopStreaming,
  startNewConversation,
  selectConversation,
  removeConversation,
  updateBackendUrl,
} = useChat();

const settingsVisible = ref(false);

onMounted(() => {
  void init();
});
</script>

<template>
  <div class="shell">
    <SessionSidebar
      :conversations="conversations"
      :active-id="activeId"
      :connection="connection"
      @create="startNewConversation"
      @select="selectConversation"
      @remove="removeConversation"
      @settings="settingsVisible = true"
    />

    <ChatWindow
      :messages="messages"
      :streaming="streaming"
      :can-send="canSend"
      :error-message="errorMessage"
      :model="health?.model ?? ''"
      :provider="health?.provider ?? ''"
      @send="sendMessage"
      @stop="stopStreaming"
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
