import type { AuthMode } from '../../composables/useAuth';
import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';

interface LoginFormDeps {
  /** 当前模式：登录与注册共用同一份表单 */
  mode: Ref<AuthMode>;
  /** 提交中读数：与登录态层的提交锁同源，避免两处各持一份状态 */
  isSubmitting: () => boolean;
  /** 登录或注册提交：令牌与用户由登录态层维护 */
  submit: (mode: AuthMode, username: string, password: string) => Promise<boolean>;
  /** 地址落盘：提交前先把地址写进去，保证请求发往用户当前填写的服务 */
  saveEndpoint: () => Promise<void>;
}

export interface LoginFormControls {
  username: Ref<string>;
  password: Ref<string>;
  canSubmit: ComputedRef<boolean>;
  handleSubmit: () => Promise<void>;
}

/** 登录表单的输入与提交：提交锁与报错位由登录态层持有，经参数注入 */
export function useLoginForm({
  mode,
  isSubmitting,
  submit,
  saveEndpoint,
}: LoginFormDeps): LoginFormControls {
  const username = ref('');
  const password = ref('');

  // 与后端 credentials 的校验规则保持一致，避免明显不合法的输入白跑一次请求
  const canSubmit = computed(
    () => username.value.trim().length >= 2 && password.value.length >= 6 && !isSubmitting(),
  );

  async function handleSubmit(): Promise<void> {
    if (!canSubmit.value) return;
    // 先落盘地址，保证登录请求发往用户当前填写的服务
    await saveEndpoint();
    await submit(mode.value, username.value, password.value);
  }

  return { username, password, canSubmit, handleSubmit };
}
