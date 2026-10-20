<script setup lang="ts">
// 文件管理：管理视角列出全部用户的上传文件，可清理。
// 列表只展示元数据（文件名、类型、大小、归属），文件字节留在服务端，不在此页预览。
import { Search, X } from 'lucide-vue-next';
import { BatchBar, DataTable, ModalDialog, PageBar, SearchBar } from '@mnemo/components';
import { formatTime } from '@mnemo/shared';
import { useFilesPage } from './files';

const { filter, table, selection, dialog, cells } = useFilesPage();
</script>

<template>
  <div class="files">
    <header class="files__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="files__lede">全部账号上传的文件，删除会同时清理服务端存放的原始字节</p>
      <p class="files__stamp">共 {{ table.total }} 个</p>
    </header>

    <div class="files__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar
        v-model:keyword="filter.keyword"
        placeholder="搜索文件名"
        @search="filter.handleSearch"
      >
        <template #icon><Search :size="15" /></template>
      </SearchBar>

      <!-- 批量条并入工具栏行：行高固定，出现/消失不会把下方表格推下去 -->
      <BatchBar
        v-if="selection.selectedKeys.length > 0"
        :count="selection.selectedKeys.length"
        @clear="selection.clearSelection"
      >
        <template #clear-icon><X :size="13" /></template>
        <button
          class="files__link files__link--danger"
          type="button"
          @click="selection.openBatchDelete"
        >
          批量删除
        </button>
      </BatchBar>
    </div>

    <p v-if="table.errorMsg" class="files__error">{{ table.errorMsg }}</p>

    <DataTable
      v-model:selected-keys="selection.selectedKeys"
      selectable
      :columns="table.columns"
      :rows="table.rows"
      :row-key="(row) => row.id"
      :loading="table.loading"
      empty-text="没有匹配的文件"
    >
      <template #name="{ row }">
        <span class="files__name" :title="row.name">{{ row.name }}</span>
      </template>
      <template #ext="{ row }">
        <span class="files__badge">{{ row.ext.toUpperCase() }}</span>
      </template>
      <template #size="{ row }">
        <span class="files__mono">{{ cells.formatBytes(row.size) }}</span>
      </template>
      <template #owner="{ row }">
        <span class="files__mono">{{ row.ownerName ?? `#${row.userId}` }}</span>
      </template>
      <template #createdAt="{ row }">
        <span class="files__mono">{{ formatTime(row.createdAt) }}</span>
      </template>
      <template #actions="{ row }">
        <button
          class="files__link files__link--danger"
          type="button"
          @click="dialog.askDelete(row)"
        >
          删除
        </button>
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
      v-if="dialog.pendingDelete"
      title="删除文件"
      confirm-text="删除"
      danger
      :loading="dialog.submitting"
      @close="dialog.closeDialog"
      @confirm="dialog.confirmDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="files__confirm">
        确定删除文件「{{
          dialog.pendingDelete.name
        }}」？服务端存放的原始字节会一并清除，操作不可撤销。
      </p>
    </ModalDialog>

    <ModalDialog
      v-if="dialog.confirmingBatch"
      title="批量删除文件"
      confirm-text="删除"
      danger
      :loading="dialog.submitting"
      @close="dialog.closeDialog"
      @confirm="dialog.confirmBatchDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="files__confirm">
        确定删除选中的
        {{ selection.selectedKeys.length }} 个文件？服务端存放的原始字节会一并清除，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style src="./files.less" lang="less" scoped></style>
