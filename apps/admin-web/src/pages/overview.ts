// 统计（PostgreSQL 聚合）与运行状态（进程内信息）来自两个接口，互不依赖，故用 allSettled 并行：
// 状态接口失败时统计卡片照常展示，只把错误提示挂出来。
import type { AdminHealth, AdminStats, MessageTrendPoint } from '@/api/types';
import { Activity, BookOpen, MessageSquare, Users } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { fetchHealth, fetchStats } from '@/api';

/**
 * 总览页的取数与派生数据：卡片、运行时长与统计时刻都由原始响应算出，
 * 模板只做装配，拉取、并行与降级策略都收在这里。
 */
export function useOverviewPage() {
  const stats = ref<AdminStats | null>(null);
  const health = ref<AdminHealth | null>(null);
  const loading = ref(true);
  const errorMsg = ref('');

  const points = computed<MessageTrendPoint[]>(() => stats.value?.messageTrend ?? []);

  /** 四张概览卡片：数据未到时值显示 0、备注显示「加载中…」，避免出现无意义的空备注 */
  const cards = computed(() => {
    const users = stats.value?.users;
    const conversations = stats.value?.conversations;
    return [
      {
        label: '用户总数',
        value: users?.total ?? 0,
        icon: Users,
        hint: users ? `管理员 ${users.admins} · 已停用 ${users.banned}` : '加载中…',
      },
      {
        label: '会话总数',
        value: conversations?.total ?? 0,
        icon: MessageSquare,
        hint: conversations ? `累计消息 ${conversations.messages} 条` : '加载中…',
      },
      {
        label: '知识库文档',
        value: stats.value?.knowledge.documents ?? 0,
        icon: BookOpen,
        hint: '已入库文档数',
      },
      {
        label: '今日消息',
        value: conversations?.messagesToday ?? 0,
        icon: Activity,
        hint: '今日新增消息量',
      },
    ];
  });

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

  /** 统计生成时刻：只到秒，作为「数据截至」的等宽小字 */
  const updatedAt = computed(() => {
    const iso = stats.value?.generatedAt;
    if (!iso) return '—';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour12: false });
  });

  /** 从 rejected 结果里取提示：reason 为 unknown，收窄成 Error 后再读 message */
  function messageOf(reason: unknown, fallback: string): string {
    return reason instanceof Error && reason.message ? reason.message : fallback;
  }

  onMounted(async () => {
    const [statsResult, healthResult] = await Promise.allSettled([fetchStats(), fetchHealth()]);
    if (statsResult.status === 'fulfilled') stats.value = statsResult.value;
    else errorMsg.value = messageOf(statsResult.reason, '总览统计加载失败');
    if (healthResult.status === 'fulfilled') health.value = healthResult.value;
    loading.value = false;
  });

  return { errorMsg, health, loading, points, cards, uptime, updatedAt };
}
