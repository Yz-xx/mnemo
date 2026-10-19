import type { AdminStats, MessageTrendPoint } from '@/api/types';
import type { Component, ComputedRef } from 'vue';
import { Activity, BookOpen, MessageSquare, Users } from 'lucide-vue-next';
import { computed, ref } from 'vue';

/**
 * 概览卡片的一项：图标是待渲染组件，数值与备注在数据未到时给出占位。
 * 入口返回的分组要带出这个形状，故须导出。
 */
export interface OverviewCard {
  label: string;
  value: number;
  icon: Component;
  hint: string;
}

export interface OverviewStatsControls {
  cards: ComputedRef<OverviewCard[]>;
  points: ComputedRef<MessageTrendPoint[]>;
  updatedAt: ComputedRef<string>;
  /** 接收统计响应：取数（含并行与降级）由入口负责，本 hook 只管派生展示数据 */
  applyStats: (value: AdminStats) => void;
}

/**
 * 总览统计接口的派生数据：卡片、趋势点与统计时刻都只依赖同一份响应，
 * 故同置一处；本 hook 不发起请求，也不反向依赖页面入口。
 */
export function useOverviewStats(): OverviewStatsControls {
  const stats = ref<AdminStats | null>(null);

  const points = computed<MessageTrendPoint[]>(() => stats.value?.messageTrend ?? []);

  /** 四张概览卡片：数据未到时值显示 0、备注显示「加载中…」，避免出现无意义的空备注 */
  const cards = computed<OverviewCard[]>(() => {
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

  /** 统计生成时刻：只到秒，作为「数据截至」的等宽小字 */
  const updatedAt = computed(() => {
    const iso = stats.value?.generatedAt;
    if (!iso) return '—';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour12: false });
  });

  function applyStats(value: AdminStats): void {
    stats.value = value;
  }

  return { cards, points, updatedAt, applyStats };
}
