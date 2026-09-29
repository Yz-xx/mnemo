<route>
{
  "meta": {
    "layout": "blank"
  }
}
</route>

<script setup lang="ts">
// 登录页：左侧品牌说明栏 + 右侧表单，两者共用 tokens.less 的令牌。
import { useLoginPage } from './login';

const { username, password, loading, errorMsg, handleLogin } = useLoginPage();
</script>

<template>
  <div class="login-page">
    <aside class="login-page__aside">
      <div class="login-page__aside-head reveal" :style="{ '--reveal-index': 0 }">
        <p class="login-page__mark">AGENT CONSOLE</p>
        <h1 class="login-page__headline">智能体管理后台</h1>
        <p class="login-page__desc">管理账号、知识库、会话与文件，查看 API 日志与运行状态。</p>
      </div>
      <p class="login-page__aside-foot reveal" :style="{ '--reveal-index': 3 }">
        INTERNAL · 仅限授权管理员
      </p>
    </aside>

    <main class="login-page__main">
      <form
        class="login-page__form reveal"
        :style="{ '--reveal-index': 1 }"
        @submit.prevent="handleLogin"
      >
        <p class="login-page__form-title">登录</p>
        <div class="login-page__field">
          <label class="login-page__label" for="username">用户名</label>
          <input
            id="username"
            v-model="username"
            class="login-page__input"
            type="text"
            autocomplete="username"
            placeholder="请输入用户名"
          />
        </div>
        <div class="login-page__field">
          <label class="login-page__label" for="password">密码</label>
          <input
            id="password"
            v-model="password"
            class="login-page__input"
            type="password"
            autocomplete="current-password"
            placeholder="请输入密码"
            @keyup.enter="handleLogin"
          />
        </div>
        <p v-if="errorMsg" class="login-page__error">{{ errorMsg }}</p>
        <button class="login-page__submit" type="submit" :disabled="loading">
          {{ loading ? '登录中…' : '登录' }}
        </button>
      </form>
    </main>
  </div>
</template>

<style src="./login.less" lang="less" scoped></style>
