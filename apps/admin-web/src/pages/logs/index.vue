<script setup lang="ts">
// API 日志：服务端在响应结束时把每个请求的汇总落库，本页只做检索与详情查看。
// 过滤三个维度（路径关键词、请求方法、状态档位）都是服务端能力，前端不本地过滤，
// 避免列表与总数对不上。
import { formatTime } from '@repo/shared';
import DataTable from '@/components/DataTable';
import ModalDialog from '@/components/ModalDialog';
import PageBar from '@/components/PageBar';
import SearchBar from '@/components/SearchBar';
import { useLogsPage } from './logs';

const {
  PAGE_SIZE,
  METHOD_OPTIONS,
  STATUS_OPTIONS,
  columns,
  keyword,
  method,
  statusKind,
  page,
  rows,
  total,
  loading,
  errorMsg,
  detail,
  detailFields,
  statusKindOf,
  handleSearch,
  handlePage,
} = useLogsPage();
</script>

<template>
  <div class="logs">
    <header class="logs__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="logs__lede">每次请求的路径、状态与耗时，按时间倒序留档</p>
      <p class="logs__stamp">共 {{ total }} 条</p>
    </header>

    <div class="logs__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar v-model:keyword="keyword" placeholder="搜索请求路径" @search="handleSearch" />
      <div class="logs__filters">
        <select v-model="method" class="logs__select" @change="handleSearch">
          <option value="">全部方法</option>
          <option v-for="item in METHOD_OPTIONS" :key="item" :value="item">{{ item }}</option>
        </select>
        <select v-model="statusKind" class="logs__select" @change="handleSearch">
          <option v-for="item in STATUS_OPTIONS" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select>
      </div>
    </div>

    <p v-if="errorMsg" class="logs__error">{{ errorMsg }}</p>

    <DataTable
      :columns="columns"
      :rows="rows"
      :row-key="(row) => row.id"
      :loading="loading"
      empty-text="没有匹配的接口日志"
    >
      <template #createdAt="{ row }">
        <span class="logs__mono">{{ formatTime(row.createdAt) }}</span>
      </template>
      <template #method="{ row }">
        <span class="logs__method">{{ row.method }}</span>
      </template>
      <template #path="{ row }">
        <span class="logs__path" :title="row.path">{{ row.path }}</span>
      </template>
      <template #status="{ row }">
        <span class="logs__status" :class="`logs__status--${statusKindOf(row.status)}`">
          {{ row.status }}
        </span>
      </template>
      <template #durationMs="{ row }">
        <span class="logs__mono">{{ row.durationMs }} ms</span>
      </template>
      <template #userId="{ row }">
        <span class="logs__mono">{{ row.userId ?? '—' }}</span>
      </template>
      <template #actions="{ row }">
        <button class="logs__link" type="button" @click="detail = row">查看</button>
      </template>
    </DataTable>

    <PageBar
      :page="page"
      :page-size="PAGE_SIZE"
      :total="total"
      :disabled="loading"
      @update:page="handlePage"
    />

    <ModalDialog
      v-if="detail"
      title="请求详情"
      width="560px"
      confirm-text="关闭"
      :cancel-text="null"
      @close="detail = null"
      @confirm="detail = null"
    >
      <dl class="logs__detail">
        <template v-for="field in detailFields" :key="field.label">
          <dt class="logs__detail-label">{{ field.label }}</dt>
          <dd class="logs__detail-value">{{ field.value }}</dd>
        </template>
      </dl>
    </ModalDialog>
  </div>
</template>

<style src="./logs.less" lang="less" scoped></style>
