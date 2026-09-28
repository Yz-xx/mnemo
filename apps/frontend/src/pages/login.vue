<route>
{
  "meta": {
    "layout": "blank"
  }
}
</route>

<script setup lang="ts">
// 登录页：左侧品牌说明栏 + 右侧表单，两者共用 tokens.less 的令牌。
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const username = ref('');
const password = ref('');
const loading = ref(false);
const errorMsg = ref('');

async function handleLogin(): Promise<void> {
  if (!username.value || !password.value) {
    errorMsg.value = '请输入用户名与密码';
    return;
  }
  errorMsg.value = '';
  loading.value = true;
  try {
    await auth.login(username.value, password.value);
    // 登录成功后回到来源页或总览
    const redirect = (route.query.redirect as string) || '/';
    await router.push(redirect);
  } catch (e) {
    errorMsg.value = (e as Error)?.message ?? '登录失败';
  } finally {
    loading.value = false;
  }
}

// 已登录则直接跳总览，避免重复登录
onMounted(() => {
  if (auth.token) {
    void router.push('/');
  }
});
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

<style scoped lang="less">
.login-page {
  display: flex;
  min-height: 100vh;

  // 左栏走重墨底：与右侧表单形成强对比，登录页不再是居中的一张白卡
  &__aside {
    flex: 0 0 46%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 56px 52px;
    background-color: var(--bg-ink);
    color: var(--text-inverse);
  }

  &__mark {
    margin: 0 0 20px;
    color: var(--primary);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--tracking-label);
  }

  &__headline {
    margin: 0 0 14px;
    font-size: 34px;
    line-height: 1.25;
    color: var(--text-inverse);
  }

  &__desc {
    margin: 0;
    max-width: 30em;
    color: var(--text-inverse-muted);
    font-size: 13px;
    line-height: 1.8;
  }

  &__aside-foot {
    margin: 0;
    color: var(--text-inverse-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }

  &__main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 32px;
  }

  &__form {
    width: 340px;
  }

  &__form-title {
    margin: 0 0 26px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 600;
    letter-spacing: var(--tracking-display);
  }

  &__field {
    margin-bottom: 18px;
  }

  &__label {
    display: block;
    margin-bottom: 6px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }

  &__input {
    width: 100%;
    height: 38px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background-color: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 14px;
    outline: none;
    transition: border-color var(--transition);

    &:focus {
      border-color: var(--primary-strong);
    }
  }

  &__error {
    margin: 0 0 14px;
    padding: 8px 12px;
    border-left: 2px solid var(--danger);
    border-radius: var(--radius);
    background-color: var(--danger-soft);
    color: var(--danger-strong);
    font-size: 13px;
  }

  &__submit {
    width: 100%;
    height: 40px;
    margin-top: 6px;
    border: 1px solid var(--primary-strong);
    border-radius: var(--radius);
    background-color: var(--primary-strong);
    color: var(--text-inverse);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: var(--tracking-label);
    transition:
      filter var(--transition),
      opacity var(--transition);

    &:hover:not(:disabled) {
      filter: brightness(0.92);
    }

    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  }
}

// 窄屏只留表单：左栏的说明性内容在空间不足时是纯负担
@media (max-width: 860px) {
  .login-page__aside {
    display: none;
  }
}
</style>
