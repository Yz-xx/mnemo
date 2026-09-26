<script setup lang="ts">
import { useLoginView } from './useLoginView';

const {
  submitting,
  errorMessage,
  mode,
  username,
  password,
  endpoint,
  reachable,
  current,
  canSubmit,
  MODE_TEXT,
  MODE_LIST,
  saveEndpoint,
  handleSubmit,
} = useLoginView();
</script>

<template>
  <div class="auth">
    <div class="auth__card">
      <span class="auth__brand">AI Agent</span>
      <p class="auth__tagline">{{ current.hint }}</p>

      <div class="auth__modes">
        <button
          v-for="item in MODE_LIST"
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

<style src="./LoginView.less" lang="less" scoped></style>
