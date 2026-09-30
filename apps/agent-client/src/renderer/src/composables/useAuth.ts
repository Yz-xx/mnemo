import type { AuthUser } from '../types';
import { ref } from 'vue';
import { readSettings, saveSettings } from '../api/bridge';
import { toErrorMessage } from '../api/client';
import { agentApi, setBackendUrl, setToken, token } from '../api/session';

export type AuthMode = 'login' | 'register';

// 令牌与后端地址的唯一来源在 api/session.ts：登录页、对话逻辑、设置抽屉读的都是同一份，
// 此处只维护用户与提交状态，避免各组件各持一份副本导致状态不同步。
const user = ref<AuthUser | null>(null);
const submitting = ref(false);
const errorMessage = ref('');

/** 令牌写入本地设置，供下次启动恢复登录态；无桥接时写入被跳过 */
async function persist(value: string): Promise<void> {
  await saveSettings({ authToken: value });
}

/** 启动时恢复登录态；令牌已过期或被服务端清除时静默退出登录 */
async function restore(): Promise<void> {
  const settings = await readSettings();
  // 先恢复地址：随后校验令牌的请求要发往上次使用的服务
  setBackendUrl(settings.backendUrl);
  if (!settings.authToken) return;
  setToken(settings.authToken);
  try {
    user.value = await agentApi.currentUser();
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
    const session =
      mode === 'login'
        ? await agentApi.login(username, password)
        : await agentApi.register(username, password);
    setToken(session.token);
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
    await agentApi.logout();
  } catch {
    // 令牌可能已过期，本地清理仍需完成
  }
  await clear();
}

/** 清空本地登录态（登出或令牌失效时调用） */
async function clear(): Promise<void> {
  setToken('');
  user.value = null;
  errorMessage.value = '';
  await persist('');
}

export function useAuth() {
  return { token, user, submitting, errorMessage, restore, submit, logout, clear };
}
