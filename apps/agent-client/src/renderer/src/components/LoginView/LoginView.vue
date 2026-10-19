<script setup lang="ts">
import { useLoginView } from './useLoginView';

const { form, mode, endpoint } = useLoginView();
</script>

<template>
  <div class="auth">
    <div class="auth__card">
      <span class="auth__brand">AI Agent</span>
      <p class="auth__tagline">{{ mode.current.hint }}</p>

      <div class="auth__modes">
        <button
          v-for="item in mode.MODE_LIST"
          :key="item"
          class="auth__mode"
          :class="{ 'auth__mode--active': mode.active === item }"
          type="button"
          @click="mode.active = item"
        >
          {{ mode.MODE_TEXT[item].title }}
        </button>
      </div>

      <form class="auth__form" @submit.prevent="form.handleSubmit">
        <label class="field">
          <span class="field__label">用户名</span>
          <input
            v-model="form.username"
            class="field__input"
            autocomplete="username"
            placeholder="2-32 位中文、字母、数字或下划线"
          />
        </label>

        <label class="field">
          <span class="field__label">密码</span>
          <input
            v-model="form.password"
            class="field__input"
            type="password"
            :autocomplete="mode.active === 'login' ? 'current-password' : 'new-password'"
            placeholder="6-32 位"
          />
        </label>

        <p v-if="form.errorMessage" class="auth__error">{{ form.errorMessage }}</p>

        <button class="btn btn--primary" type="submit" :disabled="!form.canSubmit">
          {{ form.submitting ? '处理中…' : mode.current.action }}
        </button>
      </form>

      <div class="auth__foot">
        <span
          class="dot"
          :class="{
            'dot--online': endpoint.reachable,
            'dot--offline': endpoint.reachable === false,
          }"
          :title="endpoint.reachable ? '服务可用' : '服务不可用'"
        />
        <input
          v-model="endpoint.url"
          class="auth__endpoint"
          title="后端服务地址"
          @change="endpoint.saveEndpoint"
        />
      </div>
    </div>
  </div>
</template>

<style src="./LoginView.less" lang="less" scoped></style>
