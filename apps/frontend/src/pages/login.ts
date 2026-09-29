import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

/** 登录表单的状态与提交：本地先拦非空，成功后按 redirect 回跳，失败时保留已填内容。 */
export function useLoginPage() {
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

  return { username, password, loading, errorMsg, handleLogin };
}
