<script setup lang="ts">
// 系统配置：只读展示服务端当前生效的运行参数，供运维核对。
// 密钥类配置（模型 API Key、PostgreSQL 密码、知识库令牌）服务端只回「是否已配置」，页面拿不到明文。
import { useConfigPage } from './config';

const { errorMsg, loading, groups } = useConfigPage();
</script>

<template>
  <div class="config">
    <header class="config__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="config__lede">
        服务端当前生效的运行参数，密钥类配置只显示是否已配置，改动需调整环境变量后重启
      </p>
    </header>

    <p v-if="errorMsg" class="config__error">{{ errorMsg }}</p>
    <p v-else-if="loading" class="config__hint">加载中…</p>

    <!-- 分组卡片按自适应列排布：参数多少不一，均分三列会让短组留下大片空白 -->
    <div v-else class="config__grid">
      <section
        v-for="(group, index) in groups"
        :key="group.title"
        class="config__group reveal"
        :style="{ '--reveal-index': index + 1 }"
      >
        <h2 class="config__title">{{ group.title }}</h2>
        <dl class="config__rows">
          <template v-for="row in group.rows" :key="row.label">
            <dt class="config__label">{{ row.label }}</dt>
            <dd class="config__value" :class="row.state && `config__value--${row.state}`">
              {{ row.value }}
            </dd>
          </template>
        </dl>
      </section>
    </div>
  </div>
</template>

<style src="./config.less" lang="less" scoped></style>
