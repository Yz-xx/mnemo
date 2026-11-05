<script setup lang="ts">
import { Plus, Search, X } from 'lucide-vue-next';
import { BatchBar, DataTable, ModalDialog, PageBar, SearchBar } from '@mnemo/components';
import { formatTime } from '@mnemo/shared';
import KnowledgeContentDialog from '@/components/KnowledgeContentDialog';
import KnowledgeFormDialog from '@/components/KnowledgeFormDialog';
import { useKnowledgePage } from './knowledge';

const { filter, table, selection, dialog, view, bases } = useKnowledgePage();
</script>

<template>
  <div class="knowledge">
    <div class="knowledge__toolbar">
      <SearchBar
        v-model:keyword="filter.keyword"
        placeholder="搜索文档标题"
        @search="filter.handleSearch"
      >
        <template #icon><Search :size="15" /></template>
      </SearchBar>
      <div class="knowledge__toolbar-actions">
        <!-- 批量条并入工具栏行：行高固定，出现/消失不会把下方表格推下去 -->
        <BatchBar
          v-if="selection.selectedKeys.length > 0"
          :count="selection.selectedKeys.length"
          @clear="selection.clearSelection"
        >
          <template #clear-icon><X :size="13" /></template>
          <button
            class="knowledge__link knowledge__link--danger"
            type="button"
            @click="selection.openBatchDelete"
          >
            批量删除
          </button>
        </BatchBar>
        <button class="knowledge__create" type="button" @click="dialog.openCreate">
          <Plus :size="15" />
          <span>新增全局文档</span>
        </button>
      </div>
    </div>

    <!-- 库维度概览：每库文档数与归属一眼可见，整库删除前先提示级联范围 -->
    <section class="knowledge__bases">
      <div class="knowledge__bases-head">
        <span class="knowledge__bases-title">知识库</span>
        <span class="knowledge__bases-count">共 {{ bases.list.length }} 个</span>
      </div>
      <div class="knowledge__bases-grid">
        <article v-for="base in bases.list" :key="base.id" class="knowledge__base-card">
          <div class="knowledge__base-head">
            <span class="knowledge__base-name" :title="base.name">{{ base.name }}</span>
            <span class="knowledge__base-tag">
              {{ base.visibility === 'global' ? '共享' : '私有' }}
            </span>
          </div>
          <p class="knowledge__base-desc" :title="base.description ?? ''">
            {{ base.description || '暂无描述' }}
          </p>
          <div class="knowledge__base-foot">
            <span class="knowledge__base-meta">
              {{ base.documentCount }} 篇 · {{ base.ownerName ?? '全体用户' }}
            </span>
            <button
              class="knowledge__link knowledge__link--danger"
              type="button"
              @click="bases.askDelete(base)"
            >
              删除库
            </button>
          </div>
        </article>
      </div>
    </section>

    <p v-if="table.errorMsg" class="knowledge__error">{{ table.errorMsg }}</p>

    <DataTable
      v-model:selected-keys="selection.selectedKeys"
      selectable
      :columns="table.columns"
      :rows="table.rows"
      :row-key="(row) => row.id"
      :loading="table.loading"
      empty-text="没有匹配的文档"
    >
      <template #knowledgeBase="{ row }">
        <span class="knowledge__base" :title="table.baseName(row.knowledgeBaseId)">
          {{ table.baseName(row.knowledgeBaseId) }}
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
          <button class="knowledge__link" type="button" @click="view.open(row)">查看</button>
          <button
            class="knowledge__link knowledge__link--danger"
            type="button"
            @click="dialog.askDelete(row)"
          >
            删除
          </button>
        </div>
      </template>
    </DataTable>

    <PageBar
      :page="table.page"
      :page-size="table.pageSize"
      :total="table.total"
      :disabled="table.loading"
      @update:page="table.handlePage"
    />

    <KnowledgeFormDialog
      v-if="dialog.kind === 'create'"
      :loading="dialog.submitting"
      :error="dialog.formError"
      @close="dialog.closeDialog"
      @submit="dialog.handleCreate"
    />

    <KnowledgeContentDialog
      v-if="dialog.kind === 'view' && view.content"
      :initial="view.content"
      :editing="view.editing"
      :loading="view.saving"
      :error="view.error"
      @close="dialog.closeDialog"
      @edit="view.startEdit"
      @submit="view.update"
    />

    <ModalDialog
      v-if="dialog.kind === 'delete'"
      title="删除文档"
      confirm-text="删除"
      danger
      :loading="dialog.submitting"
      @close="dialog.closeDialog"
      @confirm="dialog.confirmDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="knowledge__confirm">
        确定删除文档「{{ dialog.selected?.title }}」？其全部向量片段会一并清除，操作不可撤销。
      </p>
    </ModalDialog>

    <ModalDialog
      v-if="dialog.kind === 'batch-delete'"
      title="批量删除文档"
      confirm-text="删除"
      danger
      :loading="dialog.submitting"
      @close="dialog.closeDialog"
      @confirm="dialog.confirmBatchDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="knowledge__confirm">
        确定删除选中的
        {{ selection.selectedKeys.length }} 篇文档？其全部向量片段会一并清除，操作不可撤销。
      </p>
    </ModalDialog>

    <!-- 整库删除：与文档删除分开确认，文案明确库内文档与片段会级联清除 -->
    <ModalDialog
      v-if="bases.deleteTarget"
      title="删除知识库"
      confirm-text="删除"
      danger
      :loading="bases.deleting"
      @close="bases.cancelDelete"
      @confirm="bases.confirmDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="knowledge__confirm">
        确定删除知识库「{{ bases.deleteTarget.name }}」？库内
        {{ bases.deleteTarget.documentCount }} 篇文档及其全部向量片段会一并清除，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style src="./knowledge.less" lang="less" scoped></style>
