import { readonly, ref } from 'vue';
import { DEFAULT_BACKEND_URL } from './bridge';
import { AgentApi } from './client';

// 桌面端会话的唯一来源：当前后端地址与登录令牌都收敛在这里，
// 登录页、对话区、设置抽屉读的都是同一份，不再各自持有副本。
// 对外只暴露只读状态与写入函数，写入路径集中，避免各处散改 ref。

const backendUrlRef = ref(DEFAULT_BACKEND_URL);
const tokenRef = ref('');

/** 当前后端服务地址（只读；写入走 setBackendUrl） */
export const backendUrl = readonly(backendUrlRef);

/** 当前登录令牌（只读；写入走 setToken），请求发起时才被读取 */
export const token = readonly(tokenRef);

/** 全应用唯一的 HTTP 客户端：地址与令牌在每次请求发起时才取值 */
export const agentApi = new AgentApi(
  () => backendUrlRef.value,
  () => tokenRef.value,
);

/** 更新当前后端地址：登录成功、保存设置、启动恢复都经此写入 */
export function setBackendUrl(url: string): void {
  backendUrlRef.value = url;
}

/** 更新当前登录令牌：登录成功写入，登出或失效时清空 */
export function setToken(value: string): void {
  tokenRef.value = value;
}
