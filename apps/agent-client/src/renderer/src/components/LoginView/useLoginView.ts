import type { AuthMode } from '../../composables/useAuth';
import type { ComputedRef, Ref } from 'vue';
import { computed, onMounted, ref, watch } from 'vue';
import { DEFAULT_BACKEND_URL, readSettings, saveSettings } from '../../api/bridge';
import { AgentApi } from '../../api/client';
import { useAuth } from '../../composables/useAuth';

const MODE_TEXT: Record<AuthMode, { title: string; action: string; hint: string }> = {
  login: { title: '登录', action: '登录', hint: '登录后即可开始与智能体对话' },
  register: { title: '注册', action: '创建账号', hint: '创建一个账号，对话记录将保存到服务端' },
};

// 标签页的渲染顺序固定在此，模板无需再做类型断言
const MODE_LIST: AuthMode[] = ['login', 'register'];

interface LoginViewControls {
  submitting: Ref<boolean>;
  errorMessage: Ref<string>;
  mode: Ref<AuthMode>;
  username: Ref<string>;
  password: Ref<string>;
  endpoint: Ref<string>;
  reachable: Ref<boolean | null>;
  current: ComputedRef<{ title: string; action: string; hint: string }>;
  canSubmit: ComputedRef<boolean>;
  MODE_TEXT: typeof MODE_TEXT;
  MODE_LIST: AuthMode[];
  saveEndpoint: () => Promise<void>;
  handleSubmit: () => Promise<void>;
}

/** 登录页的表单状态与提交：地址落盘、连通性探测与登录/注册的编排都收敛在这里 */
export function useLoginView(): LoginViewControls {
  const { submitting, errorMessage, submit } = useAuth();

  const mode = ref<AuthMode>('login');
  const username = ref('');
  const password = ref('');
  const endpoint = ref(DEFAULT_BACKEND_URL);
  // 已落盘的地址，用于避免每次提交都重复写设置；登录逻辑读取的正是这份设置
  const savedEndpoint = ref(DEFAULT_BACKEND_URL);
  const reachable = ref<boolean | null>(null);

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
    await saveSettings({ backendUrl: url });
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
    endpoint.value = (await readSettings()).backendUrl;
    savedEndpoint.value = endpoint.value;
    await checkEndpoint();
  });

  return {
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
  };
}
