import type { AdminHealth } from '@/api/types';
import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';

export interface OverviewHealthControls {
  health: Ref<AdminHealth | null>;
  uptime: ComputedRef<string>;
  /** 接收健康响应：取数由入口负责，本 hook 只管派生展示数据 */
  applyHealth: (value: AdminHealth) => void;
}

/**
 * 运行状态接口的派生数据：状态原文交模板展示，运行时长换算成可读形式。
 * 本 hook 不发起请求，也不反向依赖页面入口。
 */
export function useOverviewHealth(): OverviewHealthControls {
  const health = ref<AdminHealth | null>(null);

  /** 运行时长的可读形式：超过一天只到小时，避免状态条出现长串秒数 */
  const uptime = computed(() => {
    const seconds = health.value?.uptimeSeconds ?? 0;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days} 天 ${hours} 小时`;
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    return `${minutes} 分`;
  });

  function applyHealth(value: AdminHealth): void {
    health.value = value;
  }

  return { health, uptime, applyHealth };
}
