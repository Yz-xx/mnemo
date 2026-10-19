// 统计（PostgreSQL 聚合）与运行状态（进程内信息）来自两个接口，互不依赖，故用 allSettled 并行：
// 状态接口失败时统计卡片照常展示，只把错误提示挂出来。
import { onMounted, reactive, ref } from 'vue';
import { fetchHealth, fetchStats } from '@/api';
import { useOverviewHealth } from './useOverviewHealth';
import { useOverviewStats } from './useOverviewStats';

/**
 * 总览页：两个接口的取数结果分别交给各自的子 hook 派生展示数据。
 * 出口按关注点收敛成 status / runtime / stats 三组（页级加载与错误、运行状态、统计数据）。
 */
export function useOverviewPage() {
  const stats = useOverviewStats();
  const runtime = useOverviewHealth();

  const loading = ref(true);
  const errorMsg = ref('');

  /** 从 rejected 结果里取提示：reason 为 unknown，收窄成 Error 后再读 message */
  function messageOf(reason: unknown, fallback: string): string {
    return reason instanceof Error && reason.message ? reason.message : fallback;
  }

  onMounted(async () => {
    const [statsResult, healthResult] = await Promise.allSettled([fetchStats(), fetchHealth()]);
    if (statsResult.status === 'fulfilled') stats.applyStats(statsResult.value);
    else errorMsg.value = messageOf(statsResult.reason, '总览统计加载失败');
    if (healthResult.status === 'fulfilled') runtime.applyHealth(healthResult.value);
    loading.value = false;
  });

  // 分组包一层 reactive：嵌套在普通对象里的 ref 在模板中不会被解包，包过 reactive 才会
  return {
    status: reactive({ loading, errorMsg }),
    runtime: reactive({ health: runtime.health, uptime: runtime.uptime }),
    stats: reactive({ cards: stats.cards, points: stats.points, updatedAt: stats.updatedAt }),
  };
}
