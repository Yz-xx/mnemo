<script setup lang="ts">
// 总览：页头说明 + 四张统计卡片 + 运行状态条 + 近 7 天消息趋势图。
// 统计（MySQL 聚合）与运行状态（进程内信息）来自两个接口，互不依赖，故用 allSettled 并行：
// 状态接口失败时统计卡片照常展示，只把错误提示挂出来。
import type { AdminHealth, AdminStats, MessageTrendPoint } from '@/api/types';
import { Activity, BookOpen, MessageSquare, Users } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { fetchHealth, fetchStats } from '@/api/admin';
import MessageTrendChart from '@/components/MessageTrendChart';

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
</script>

<template>
  <div class="overview">
    <p v-if="errorMsg" class="overview__error">{{ errorMsg }}</p>

    <header class="overview__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="overview__lede">用户、会话与知识库的实时规模</p>
      <p class="overview__stamp">数据截至 {{ updatedAt }}</p>
    </header>

    <section class="overview__grid">
      <div
        v-for="(card, index) in cards"
        :key="card.label"
        class="overview__card reveal"
        :style="{ '--reveal-index': index + 1 }"
      >
        <div class="overview__card-head">
          <component :is="card.icon" :size="16" class="overview__card-icon" />
          <span class="overview__card-label">{{ card.label }}</span>
        </div>
        <div class="overview__card-value">{{ card.value }}</div>
        <div class="overview__card-hint">{{ card.hint }}</div>
      </div>
    </section>

    <section
      v-if="health"
      class="overview__status reveal"
      :style="{ '--reveal-index': cards.length + 1 }"
    >
      <span class="overview__status-tag">RUNTIME</span>
      <span class="overview__dot" />
      <span class="overview__status-item">{{ health.service }} 运行中</span>
      <span class="overview__status-item">{{ health.provider }} · {{ health.model }}</span>
      <span class="overview__status-item">
        知识库{{ health.knowledgeEnabled ? '已启用' : '未启用' }}
      </span>
      <span class="overview__status-item">运行时长 {{ uptime }}</span>
      <span class="overview__status-item">MySQL {{ health.mysql }}</span>
    </section>

    <section class="overview__block reveal" :style="{ '--reveal-index': cards.length + 2 }">
      <div class="overview__block-head">
        <h2 class="overview__block-title">近 7 天消息量</h2>
        <span class="overview__block-note">LAST 7 DAYS</span>
      </div>
      <MessageTrendChart :points="points" :loading="loading" />
    </section>
  </div>
</template>

<style scoped lang="less">
.overview {
  display: flex;
  flex-direction: column;
  gap: 20px;

  &__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
  }

  &__lede {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
  }

  &__stamp {
    margin: 0;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--tracking-mono);
  }

  &__error {
    margin: 0;
    padding: 10px 14px;
    background-color: var(--danger-soft);
    border-left: 2px solid var(--danger);
    border-radius: var(--radius);
    color: var(--danger-strong);
    font-size: 13px;
  }

  // 四张卡片靠 1px 细线分格而非各自成卡：去掉无差别的圆角与阴影，让结构由线条立起来；
  // 四列等宽——分格线会把列宽差异放大成错位感；minmax(0,…) 挡住长数字撑宽轨道
  &__grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1px;
    background-color: var(--border);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  &__card {
    padding: 18px 20px 20px;
    background-color: var(--bg);
  }

  &__card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
  }

  &__card-icon {
    color: var(--primary);
  }

  &__card-label {
    color: var(--text-muted);
    font-size: 12px;
    letter-spacing: var(--tracking-label);
  }

  // 关键指标走衬线族 + 等宽数字：与正文拉开排版层级，且数值纵向对齐时不跳动
  // 行盒写死 40px 而非倍数行高：把数值行高度与字号解耦，改字号不会挪动下方提示行
  &__card-value {
    color: var(--text);
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 600;
    line-height: 40px;
    letter-spacing: var(--tracking-display);
    font-variant-numeric: tabular-nums;
  }

  &__card-hint {
    margin-top: 8px;
    color: var(--text-faint);
    font-size: 12px;
  }

  &__status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    padding: 12px 18px;
    background-color: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  &__status-tag {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }

  // 状态圆点是非文字元素，按图形 3:1 的标准取 --success（3.3:1）
  &__dot {
    width: 8px;
    height: 8px;
    background-color: var(--success);
    border-radius: 50%;
    animation: overview-pulse 2.4s ease-in-out infinite;
  }

  &__status-item {
    color: var(--text-muted);
    font-size: 13px;
  }

  &__block {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__block-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  &__block-title {
    margin: 0;
    color: var(--text);
    font-size: 16px;
  }

  &__block-note {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }
}

@keyframes overview-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .overview__dot {
    animation: none;
  }
}
</style>
