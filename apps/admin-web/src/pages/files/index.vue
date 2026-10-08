<script setup lang="ts">
// 文件管理：管理视角列出全部用户的上传文件，可清理。
// 列表只展示元数据（文件名、类型、大小、归属），文件字节留在服务端，不在此页预览。
import { Search, X } from 'lucide-vue-next';
import { BatchBar, DataTable, ModalDialog, PageBar, SearchBar } from '@repo/components';
import { formatTime } from '@repo/shared';
import { useFilesPage } from './files';

const {
  PAGE_SIZE,
  columns,
  keyword,
  page,
  rows,
  total,
  loading,
  errorMsg,
  pendingDelete,
  confirmingBatch,
  submitting,
  selectedKeys,
  formatBytes,
  handleSearch,
  handlePage,
  clearSelection,
  confirmDelete,
  confirmBatchDelete,
} = useFilesPage();
</script>

<template>
  <div class="files">
    <header class="files__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="files__lede">全部账号上传的文件，删除会同时清理服务端存放的原始字节</p>
      <p class="files__stamp">共 {{ total }} 个</p>
    </header>

    <div class="files__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar v-model:keyword="keyword" placeholder="搜索文件名" @search="handleSearch">
        <template #icon><Search :size="15" /></template>
      </SearchBar>
    </div>

    <p v-if="errorMsg" class="files__error">{{ errorMsg }}</p>

    <BatchBar v-if="selectedKeys.length > 0" :count="selectedKeys.length" @clear="clearSelection">
      <template #clear-icon><X :size="13" /></template>
      <button class="files__link files__link--danger" type="button" @click="confirmingBatch = true">
        批量删除
      </button>
    </BatchBar>

    <DataTable
      v-model:selected-keys="selectedKeys"
      selectable
      :columns="columns"
      :rows="rows"
      :row-key="(row) => row.id"
      :loading="loading"
      empty-text="没有匹配的文件"
    >
      <template #name="{ row }">
        <span class="files__name" :title="row.name">{{ row.name }}</span>
      </template>
      <template #ext="{ row }">
        <span class="files__badge">{{ row.ext.toUpperCase() }}</span>
      </template>
      <template #size="{ row }">
        <span class="files__mono">{{ formatBytes(row.size) }}</span>
      </template>
      <template #owner="{ row }">
        <span class="files__mono">{{ row.ownerName ?? `#${row.userId}` }}</span>
      </template>
      <template #createdAt="{ row }">
        <span class="files__mono">{{ formatTime(row.createdAt) }}</span>
      </template>
      <template #actions="{ row }">
        <button class="files__link files__link--danger" type="button" @click="pendingDelete = row">
          删除
        </button>
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
      v-if="pendingDelete"
      title="删除文件"
      confirm-text="删除"
      danger
      :loading="submitting"
      @close="pendingDelete = null"
      @confirm="confirmDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="files__confirm">
        确定删除文件「{{ pendingDelete.name }}」？服务端存放的原始字节会一并清除，操作不可撤销。
      </p>
    </ModalDialog>

    <ModalDialog
      v-if="confirmingBatch"
      title="批量删除文件"
      confirm-text="删除"
      danger
      :loading="submitting"
      @close="confirmingBatch = false"
      @confirm="confirmBatchDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="files__confirm">
        确定删除选中的
        {{ selectedKeys.length }} 个文件？服务端存放的原始字节会一并清除，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style src="./files.less" lang="less" scoped></style>
