<script setup lang="ts">
import { ref } from 'vue';
import type { HealthInfo } from '../api/client';
import KnowledgePanel from './KnowledgePanel.vue';

const props = defineProps<{
  backendUrl: string;
  health: HealthInfo | null;
}>();

const emit = defineEmits<{
  close: [];
  save: [url: string];
}>();

const tab = ref<'connection' | 'knowledge'>('connection');
const urlDraft = ref(props.backendUrl);
</script>

<template>
  <div class="drawer">
    <div class="drawer__panel">
      <header class="drawer__head">
        <div class="tabs">
          <button
            class="tab"
            :class="{ 'tab--active': tab === 'connection' }"
            @click="tab = 'connection'"
          >
            连接
          </button>
          <button
            class="tab"
            :class="{ 'tab--active': tab === 'knowledge' }"
            @click="tab = 'knowledge'"
          >
            知识库
          </button>
        </div>
        <button class="icon-btn" title="关闭" @click="emit('close')">×</button>
      </header>

      <section v-if="tab === 'connection'" class="drawer__body">
        <label class="field">
          <span class="field__label">后端服务地址</span>
          <input v-model="urlDraft" class="field__input" placeholder="http://localhost:3000" />
        </label>
        <p class="drawer__hint">当前状态：{{ health ? `已连接（${health.model}）` : '未连接' }}</p>
        <button class="btn btn--primary" @click="emit('save', urlDraft)">保存并重连</button>
      </section>

      <!-- 知识库面板自行管理文档列表，地址优先取当前草稿，为空时回退到已保存地址 -->
      <KnowledgePanel v-else :backend-url="urlDraft.trim() || backendUrl" />
    </div>

    <div class="drawer__mask" @click="emit('close')" />
  </div>
</template>
