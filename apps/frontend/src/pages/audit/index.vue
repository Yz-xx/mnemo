<script setup lang="ts">
import DataTable from '@/components/DataTable';
import ModalDialog from '@/components/ModalDialog';
import PageBar from '@/components/PageBar';
import SearchBar from '@/components/SearchBar';
import { formatTime } from '@/utils/time';
import { useAuditPage } from './audit';

const {
  PAGE_SIZE,
  columns,
  keyword,
  detail,
  detailFields,
  statusKindOf,
  actorLabel,
  rows,
  total,
  page,
  loading,
  errorMsg,
  handleSearch,
  handlePage,
} = useAuditPage();
</script>

<template>
  <div class="audit">
    <header class="audit__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="audit__lede">管理端的写入操作留档，含被拒绝的尝试，按时间倒序</p>
      <p class="audit__stamp">共 {{ total }} 条</p>
    </header>

    <div class="audit__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar v-model:keyword="keyword" placeholder="搜索操作路径" @search="handleSearch" />
    </div>

    <p v-if="errorMsg" class="audit__error">{{ errorMsg }}</p>

    <DataTable
      :columns="columns"
      :rows="rows"
      :row-key="(row) => row.id"
      :loading="loading"
      empty-text="没有匹配的操作记录"
    >
      <template #createdAt="{ row }">
        <span class="audit__mono">{{ formatTime(row.createdAt) }}</span>
      </template>
      <template #actor="{ row }">
        <span class="audit__actor">{{ actorLabel(row) }}</span>
      </template>
      <template #method="{ row }">
        <span class="audit__method">{{ row.method }}</span>
      </template>
      <template #path="{ row }">
        <span class="audit__path" :title="row.path">{{ row.path }}</span>
      </template>
      <template #status="{ row }">
        <span class="audit__status" :class="`audit__status--${statusKindOf(row.status)}`">
          {{ row.status }}
        </span>
      </template>
      <template #actions="{ row }">
        <button class="audit__link" type="button" @click="detail = row">查看</button>
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
      title="操作详情"
      width="560px"
      confirm-text="关闭"
      :cancel-text="null"
      @close="detail = null"
      @confirm="detail = null"
    >
      <dl class="audit__detail">
        <template v-for="field in detailFields" :key="field.label">
          <dt class="audit__detail-label">{{ field.label }}</dt>
          <dd class="audit__detail-value">{{ field.value }}</dd>
        </template>
      </dl>
    </ModalDialog>
  </div>
</template>

<style src="./audit.less" lang="less" scoped></style>
