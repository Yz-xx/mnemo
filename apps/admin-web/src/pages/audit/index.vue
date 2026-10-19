<script setup lang="ts">
import { Search, X } from 'lucide-vue-next';
import { DataTable, ModalDialog, PageBar, SearchBar } from '@repo/components';
import { formatTime } from '@repo/shared';
import { useAuditPage } from './audit';

const { filter, table, detail, cells } = useAuditPage();
</script>

<template>
  <div class="audit">
    <header class="audit__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="audit__lede">管理端的写入操作留档，含被拒绝的尝试，按时间倒序</p>
      <p class="audit__stamp">共 {{ table.total }} 条</p>
    </header>

    <div class="audit__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar
        v-model:keyword="filter.keyword"
        placeholder="搜索操作路径"
        @search="filter.handleSearch"
      >
        <template #icon><Search :size="15" /></template>
      </SearchBar>
    </div>

    <p v-if="table.errorMsg" class="audit__error">{{ table.errorMsg }}</p>

    <DataTable
      :columns="table.columns"
      :rows="table.rows"
      :row-key="(row) => row.id"
      :loading="table.loading"
      empty-text="没有匹配的操作记录"
    >
      <template #createdAt="{ row }">
        <span class="audit__mono">{{ formatTime(row.createdAt) }}</span>
      </template>
      <template #actor="{ row }">
        <span class="audit__actor">{{ cells.actorLabel(row) }}</span>
      </template>
      <template #method="{ row }">
        <span class="audit__method">{{ row.method }}</span>
      </template>
      <template #path="{ row }">
        <span class="audit__path" :title="row.path">{{ row.path }}</span>
      </template>
      <template #status="{ row }">
        <span class="audit__status" :class="`audit__status--${cells.statusKindOf(row.status)}`">
          {{ row.status }}
        </span>
      </template>
      <template #actions="{ row }">
        <button class="audit__link" type="button" @click="detail.row = row">查看</button>
      </template>
    </DataTable>

    <PageBar
      :page="table.page"
      :page-size="table.PAGE_SIZE"
      :total="table.total"
      :disabled="table.loading"
      @update:page="table.handlePage"
    />

    <ModalDialog
      v-if="detail.row"
      title="操作详情"
      width="560px"
      confirm-text="关闭"
      :cancel-text="null"
      @close="detail.row = null"
      @confirm="detail.row = null"
    >
      <template #close-icon><X :size="16" /></template>
      <dl class="audit__detail">
        <template v-for="field in detail.fields" :key="field.label">
          <dt class="audit__detail-label">{{ field.label }}</dt>
          <dd class="audit__detail-value">{{ field.value }}</dd>
        </template>
      </dl>
    </ModalDialog>
  </div>
</template>

<style src="./audit.less" lang="less" scoped></style>
