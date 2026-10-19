import type { HealthInfo } from '../api/client';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { DEFAULT_BACKEND_URL, saveSettings } from '../api/bridge';
import { agentApi, setBackendUrl } from '../api/session';

export type ConnectionState = 'idle' | 'online' | 'offline';

interface ChatConnectionDeps {
  /** 对话区的错误位：探测成功或失败由本 hook 统一清空 / 写入 */
  errorMessage: Ref<string>;
  /** 切换地址后要回读该服务上的会话，取数与状态归会话组，故以回调注入 */
  refreshConversations: () => Promise<void>;
}

export interface ChatConnectionControls {
  connection: Ref<ConnectionState>;
  health: Ref<HealthInfo | null>;
  refreshHealth: () => Promise<void>;
  updateBackendUrl: (url: string) => Promise<void>;
  resetConnection: () => void;
}

/**
 * 后端连接状态与地址切换：健康探测、地址落盘与重连编排都在这里，
 * 会话列表的回读经参数注入，本 hook 不反向依赖会话组。
 */
export function useChatConnection({
  errorMessage,
  refreshConversations,
}: ChatConnectionDeps): ChatConnectionControls {
  const connection = ref<ConnectionState>('idle');
  const health = ref<HealthInfo | null>(null);

  /** 探测后端可用性，同时刷新当前模型信息 */
  async function refreshHealth(): Promise<void> {
    try {
      health.value = await agentApi.health();
      connection.value = 'online';
      errorMessage.value = '';
    } catch {
      health.value = null;
      connection.value = 'offline';
    }
  }

  /** 切换后端地址并持久化到本地设置 */
  async function updateBackendUrl(url: string): Promise<void> {
    const nextUrl = url.trim() || DEFAULT_BACKEND_URL;
    setBackendUrl(nextUrl);
    await saveSettings({ backendUrl: nextUrl });
    connection.value = 'idle';
    await refreshHealth();
    await refreshConversations();
  }

  /** 登出或令牌失效时回到未探测状态，连接读数与模型信息一并作废 */
  function resetConnection(): void {
    connection.value = 'idle';
    health.value = null;
  }

  return { connection, health, refreshHealth, updateBackendUrl, resetConnection };
}
