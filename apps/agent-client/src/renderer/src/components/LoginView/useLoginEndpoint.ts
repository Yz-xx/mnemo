import type { Ref } from 'vue';
import { onMounted, ref } from 'vue';
import { DEFAULT_BACKEND_URL, readSettings, saveSettings } from '../../api/bridge';
import { AgentApi } from '../../api/client';
import { setBackendUrl } from '../../api/session';

export interface LoginEndpointControls {
  endpoint: Ref<string>;
  reachable: Ref<boolean | null>;
  saveEndpoint: () => Promise<void>;
}

/**
 * 服务地址的编辑、落盘与探活：地址填错要在提交前就被发现。
 * 探活保留临时 AgentApi 实例——它探的是尚未落盘的草稿地址。
 */
export function useLoginEndpoint(): LoginEndpointControls {
  const endpoint = ref(DEFAULT_BACKEND_URL);
  // 已落盘的地址，用于避免每次提交都重复写设置；登录逻辑读取的正是这份设置
  const savedEndpoint = ref(DEFAULT_BACKEND_URL);
  const reachable = ref<boolean | null>(null);

  /** 探测后端可用性，让地址填错在提交前就能被发现 */
  async function checkEndpoint(): Promise<void> {
    try {
      await new AgentApi(endpoint.value).health();
      reachable.value = true;
    } catch {
      reachable.value = false;
    }
  }

  /** 地址变更时持久化并重新探测；全局会话与登录请求读取的都是同一份设置 */
  async function saveEndpoint(): Promise<void> {
    const url = endpoint.value.trim() || DEFAULT_BACKEND_URL;
    endpoint.value = url;
    if (url === savedEndpoint.value) return;
    savedEndpoint.value = url;
    setBackendUrl(url);
    await saveSettings({ backendUrl: url });
    await checkEndpoint();
  }

  onMounted(async () => {
    endpoint.value = (await readSettings()).backendUrl;
    savedEndpoint.value = endpoint.value;
    await checkEndpoint();
  });

  return { endpoint, reachable, saveEndpoint };
}
