<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { AgentApi } from '../api/client';
import { useAuth } from '../composables/useAuth';
import type { AuthMode } from '../composables/useAuth';

const { submitting, errorMessage, submit } = useAuth();

const DEFAULT_BACKEND_URL = 'http://localhost:3000';

const mode = ref<AuthMode>('login');
const username = ref('');
const password = ref('');
const endpoint = ref(DEFAULT_BACKEND_URL);
// 已落盘的地址，用于避免每次提交都重复写设置；登录逻辑读取的正是这份设置
const savedEndpoint = ref(DEFAULT_BACKEND_URL);
const reachable = ref<boolean | null>(null);

const MODE_TEXT: Record<AuthMode, { title: string; action: string; hint: string }> = {
  login: { title: '登录', action: '登录', hint: '登录后即可开始与智能体对话' },
  register: { title: '注册', action: '创建账号', hint: '创建一个账号，对话记录将保存到服务端' },
};

const current = computed(() => MODE_TEXT[mode.value]);
// 与后端 credentials 的校验规则保持一致，避免明显不合法的输入白跑一次请求
const canSubmit = computed(
  () => username.value.trim().length >= 2 && password.value.length >= 6 && !submitting.value,
);

/** 探测后端可用性，让地址填错在提交前就能被发现 */
async function checkEndpoint(): Promise<void> {
  try {
    await new AgentApi(endpoint.value).health();
    reachable.value = true;
  } catch {
    reachable.value = false;
  }
}

/** 地址变更时持久化并重新探测；主界面读取的是同一份设置 */
async function saveEndpoint(): Promise<void> {
  const url = endpoint.value.trim() || DEFAULT_BACKEND_URL;
  endpoint.value = url;
  if (url === savedEndpoint.value) return;
  savedEndpoint.value = url;
  await window.desktopApi.saveSettings({ backendUrl: url });
  await checkEndpoint();
}

async function handleSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  // 先落盘地址，保证登录请求发往用户当前填写的服务
  await saveEndpoint();
  await submit(mode.value, username.value, password.value);
}

// 切换登录/注册时清掉上一次的报错，避免残留信息造成困惑
watch(mode, () => {
  errorMessage.value = '';
});

onMounted(async () => {
  endpoint.value = (await window.desktopApi.getSettings()).backendUrl;
  savedEndpoint.value = endpoint.value;
  await checkEndpoint();
});
</script>

<template>
  <div class="auth">
    <div class="auth__card">
      <span class="auth__brand">AI Agent</span>
      <p class="auth__tagline">{{ current.hint }}</p>

      <div class="auth__modes">
        <button
          v-for="item in ['login', 'register'] as AuthMode[]"
          :key="item"
          class="auth__mode"
          :class="{ 'auth__mode--active': mode === item }"
          type="button"
          @click="mode = item"
        >
          {{ MODE_TEXT[item].title }}
        </button>
      </div>

      <form class="auth__form" @submit.prevent="handleSubmit">
        <label class="field">
          <span class="field__label">用户名</span>
          <input
            v-model="username"
            class="field__input"
            autocomplete="username"
            placeholder="2-32 位中文、字母、数字或下划线"
          />
        </label>

        <label class="field">
          <span class="field__label">密码</span>
          <input
            v-model="password"
            class="field__input"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            placeholder="6-32 位"
          />
        </label>

        <p v-if="errorMessage" class="auth__error">{{ errorMessage }}</p>

        <button class="btn btn--primary" type="submit" :disabled="!canSubmit">
          {{ submitting ? '处理中…' : current.action }}
        </button>
      </form>

      <div class="auth__foot">
        <span
          class="dot"
          :class="{ 'dot--online': reachable, 'dot--offline': reachable === false }"
          :title="reachable ? '服务可用' : '服务不可用'"
        />
        <input
          v-model="endpoint"
          class="auth__endpoint"
          title="后端服务地址"
          @change="saveEndpoint"
        />
      </div>
    </div>
  </div>
</template>
