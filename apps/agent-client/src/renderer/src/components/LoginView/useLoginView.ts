import { computed, reactive } from 'vue';
import { useAuth } from '../../composables/useAuth';
import { useLoginEndpoint } from './useLoginEndpoint';
import { useLoginForm } from './useLoginForm';
import { MODE_LIST, MODE_TEXT, useLoginMode } from './useLoginMode';

/**
 * 登录页的装配：表单、模式、服务地址三组出口。
 * 提交锁与报错位来自模块级单例 useAuth，经 computed 桥接进表单组，
 * 模板读到的仍是同一份底层状态，行为不变。
 */
export function useLoginView() {
  const auth = useAuth();

  const authMode = useLoginMode({
    clearError: () => {
      auth.form.errorMessage = '';
    },
  });
  const endpoint = useLoginEndpoint();
  const form = useLoginForm({
    mode: authMode.mode,
    isSubmitting: () => auth.form.submitting,
    submit: (mode, username, password) => auth.form.submit(mode, username, password),
    saveEndpoint: endpoint.saveEndpoint,
  });

  // 分组包一层 reactive：嵌套在普通对象里的 ref 在模板中不会被解包，包过 reactive 才会
  return {
    form: reactive({
      username: form.username,
      password: form.password,
      canSubmit: form.canSubmit,
      handleSubmit: form.handleSubmit,
      submitting: computed(() => auth.form.submitting),
      errorMessage: computed(() => auth.form.errorMessage),
    }),
    mode: reactive({
      active: authMode.mode,
      current: authMode.current,
      MODE_TEXT,
      MODE_LIST,
    }),
    endpoint: reactive({
      url: endpoint.endpoint,
      reachable: endpoint.reachable,
      saveEndpoint: endpoint.saveEndpoint,
    }),
  };
}
