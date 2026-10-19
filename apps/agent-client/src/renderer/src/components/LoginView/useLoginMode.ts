import type { AuthMode } from '../../composables/useAuth';
import type { ComputedRef, Ref } from 'vue';
import { computed, ref, watch } from 'vue';

/** 模式元信息：标题、按钮文案与副标题同源于此，模板不再自己拼文案 */
export const MODE_TEXT: Record<AuthMode, { title: string; action: string; hint: string }> = {
  login: { title: '登录', action: '登录', hint: '登录后即可开始与智能体对话' },
  register: { title: '注册', action: '创建账号', hint: '创建一个账号，对话记录将保存到服务端' },
};

// 标签页的渲染顺序固定在此，模板无需再做类型断言
export const MODE_LIST: AuthMode[] = ['login', 'register'];

interface LoginModeDeps {
  /** 切换模式时清掉上一次的报错：避免残留信息造成困惑 */
  clearError: () => void;
}

export interface LoginModeControls {
  mode: Ref<AuthMode>;
  current: ComputedRef<{ title: string; action: string; hint: string }>;
}

/** 登录/注册的模式切换与文案派生，报错清理经参数注入 */
export function useLoginMode({ clearError }: LoginModeDeps): LoginModeControls {
  const mode = ref<AuthMode>('login');

  const current = computed(() => MODE_TEXT[mode.value]);

  watch(mode, () => clearError());

  return { mode, current };
}
