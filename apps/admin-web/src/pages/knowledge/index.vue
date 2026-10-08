<script setup lang="ts">
import { Plus, Search, X } from 'lucide-vue-next';
import { BatchBar, DataTable, ModalDialog, PageBar, SearchBar } from '@repo/components';
import { formatTime } from '@repo/shared';
import KnowledgeContentDialog from '@/components/KnowledgeContentDialog';
import KnowledgeFormDialog from '@/components/KnowledgeFormDialog';
import { useKnowledgePage } from './knowledge';

const {
  PAGE_SIZE,
  SCOPE_LABEL,
  columns,
  keyword,
  page,
  rows,
  total,
  loading,
  errorMsg,
  dialog,
  selected,
  submitting,
  formError,
  selectedKeys,
  viewContent,
  viewEditing,
  viewSaving,
  viewError,
  handleSearch,
  handlePage,
  clearSelection,
  openCreate,
  askDelete,
  openBatchDelete,
  openView,
  startEdit,
  closeDialog,
  handleCreate,
  confirmDelete,
  confirmBatchDelete,
  handleUpdateDocument,
} = useKnowledgePage();
</script>

<template>
  <div class="knowledge">
    <div class="knowledge__toolbar">
      <SearchBar v-model:keyword="keyword" placeholder="搜索文档标题" @search="handleSearch">
        <template #icon><Search :size="15" /></template>
      </SearchBar>
      <button class="knowledge__create" type="button" @click="openCreate">
        <Plus :size="15" />
        <span>新增全局文档</span>
      </button>
    </div>

    <p v-if="errorMsg" class="knowledge__error">{{ errorMsg }}</p>

    <BatchBar v-if="selectedKeys.length > 0" :count="selectedKeys.length" @clear="clearSelection">
      <template #clear-icon><X :size="13" /></template>
      <button
        class="knowledge__link knowledge__link--danger"
        type="button"
        @click="openBatchDelete"
      >
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
      empty-text="没有匹配的文档"
    >
      <template #scope="{ row }">
        <span class="knowledge__badge" :class="`knowledge__badge--${row.scope}`">
          {{ SCOPE_LABEL[row.scope] }}
        </span>
      </template>
      <template #owner="{ row }">
        <span :class="{ 'knowledge__owner--none': !row.ownerName }">
          {{ row.ownerName ?? '—' }}
        </span>
      </template>
      <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
      <template #actions="{ row }">
        <div class="knowledge__actions">
          <button class="knowledge__link" type="button" @click="openView(row)">查看</button>
          <button
            class="knowledge__link knowledge__link--danger"
            type="button"
            @click="askDelete(row)"
          >
            删除
          </button>
        </div>
      </template>
    </DataTable>

    <PageBar
      :page="page"
      :page-size="PAGE_SIZE"
      :total="total"
      :disabled="loading"
      @update:page="handlePage"
    />

    <KnowledgeFormDialog
      v-if="dialog === 'create'"
      :loading="submitting"
      :error="formError"
      @close="closeDialog"
      @submit="handleCreate"
    />

    <KnowledgeContentDialog
      v-if="dialog === 'view' && viewContent"
      :initial="viewContent"
      :editing="viewEditing"
      :loading="viewSaving"
      :error="viewError"
      @close="closeDialog"
      @edit="startEdit"
      @submit="handleUpdateDocument"
    />

    <ModalDialog
      v-if="dialog === 'delete'"
      title="删除文档"
      confirm-text="删除"
      danger
      :loading="submitting"
      @close="closeDialog"
      @confirm="confirmDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="knowledge__confirm">
        确定删除文档「{{ selected?.title }}」？其全部向量片段会一并清除，操作不可撤销。
      </p>
    </ModalDialog>

    <ModalDialog
      v-if="dialog === 'batch-delete'"
      title="批量删除文档"
      confirm-text="删除"
      danger
      :loading="submitting"
      @close="closeDialog"
      @confirm="confirmBatchDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="knowledge__confirm">
        确定删除选中的 {{ selectedKeys.length }} 篇文档？其全部向量片段会一并清除，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style src="./knowledge.less" lang="less" scoped></style>
