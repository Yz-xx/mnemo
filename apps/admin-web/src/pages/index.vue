<script setup lang="ts">
// 总览：页头说明 + 四张统计卡片 + 运行状态条 + 近 7 天消息趋势图。
import MessageTrendChart from '@/components/MessageTrendChart';
import { useOverviewPage } from './overview';

const { errorMsg, health, loading, points, cards, uptime, updatedAt } = useOverviewPage();
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
      <span class="overview__status-item">PostgreSQL {{ health.postgres }}</span>
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

<style src="./overview.less" lang="less" scoped></style>
