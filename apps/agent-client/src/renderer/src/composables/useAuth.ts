import { ref } from 'vue';
import { readSettings, saveSettings } from '../api/bridge';
import { AgentApi, toErrorMessage } from '../api/client';
import type { AuthUser } from '../types';

export type AuthMode = 'login' | 'register';

// 登录态是模块级单例：登录页、对话逻辑、设置抽屉都要读取同一份令牌，
// 集中在此可避免各组件各持一份副本导致状态不同步。
const token = ref('');
const user = ref<AuthUser | null>(null);
const submitting = ref(false);
const errorMessage = ref('');

/** 以当前后端地址与令牌构造客户端；浏览器调试环境无桥接时退回默认地址 */
async function createApi(): Promise<AgentApi> {
  const settings = await readSettings();
  return new AgentApi(settings.backendUrl, token.value);
}

/** 令牌写入本地设置，供下次启动恢复登录态；无桥接时写入被跳过 */
async function persist(value: string): Promise<void> {
  await saveSettings({ authToken: value });
}

/** 启动时恢复登录态；令牌已过期或被服务端清除时静默退出登录 */
async function restore(): Promise<void> {
  const settings = await readSettings();
  if (!settings.authToken) return;
  token.value = settings.authToken;
  try {
    user.value = await (await createApi()).currentUser();
  } catch {
    await clear();
  }
}

/** 提交登录或注册，成功返回 true */
async function submit(mode: AuthMode, username: string, password: string): Promise<boolean> {
  if (submitting.value) return false;
  submitting.value = true;
  errorMessage.value = '';
  try {
    const api = await createApi();
    const session =
      mode === 'login'
        ? await api.login(username, password)
        : await api.register(username, password);
    token.value = session.token;
    user.value = session.user;
    await persist(session.token);
    return true;
  } catch (error) {
    errorMessage.value = toErrorMessage(error);
    return false;
  } finally {
    submitting.value = false;
  }
}

/** 退出登录：先请求服务端销毁会话，失败也不阻塞本地清理 */
async function logout(): Promise<void> {
  try {
    await (await createApi()).logout();
  } catch {
    // 令牌可能已过期，本地清理仍需完成
  }
  await clear();
}

/** 清空本地登录态（登出或令牌失效时调用） */
async function clear(): Promise<void> {
  token.value = '';
  user.value = null;
  errorMessage.value = '';
  await persist('');
}

export function useAuth() {
  return { token, user, submitting, errorMessage, restore, submit, logout, clear };
}
