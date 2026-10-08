<script setup lang="ts">
import { Search, X } from 'lucide-vue-next';
import { BatchBar, DataTable, ModalDialog, PageBar, SearchBar } from '@repo/components';
import { formatTime } from '@repo/shared';
import { useConversationsPage } from './conversations';

const {
  PAGE_SIZE,
  columns,
  ROLE_LABEL,
  keyword,
  detail,
  detailLoading,
  pendingDelete,
  confirmingBatch,
  submitting,
  selectedKeys,
  clearSelection,
  closeDetail,
  openDetail,
  confirmDelete,
  confirmBatchDelete,
  rows,
  total,
  page,
  loading,
  errorMsg,
  handleSearch,
  handlePage,
} = useConversationsPage();
</script>

<template>
  <div class="conversations">
    <header class="conversations__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="conversations__lede">全部账号的对话记录，可展开核查消息内容</p>
      <p class="conversations__stamp">共 {{ total }} 条</p>
    </header>

    <div class="conversations__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar v-model:keyword="keyword" placeholder="搜索会话标题" @search="handleSearch">
        <template #icon><Search :size="15" /></template>
      </SearchBar>
    </div>

    <p v-if="errorMsg" class="conversations__error">{{ errorMsg }}</p>

    <BatchBar v-if="selectedKeys.length > 0" :count="selectedKeys.length" @clear="clearSelection">
      <template #clear-icon><X :size="13" /></template>
      <button
        class="conversations__link conversations__link--danger"
        type="button"
        @click="confirmingBatch = true"
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
      empty-text="没有匹配的会话"
    >
      <template #title="{ row }">
        <span class="conversations__title" :title="row.title">{{ row.title }}</span>
      </template>
      <template #owner="{ row }">
        <span class="conversations__mono">{{ row.ownerName ?? `#${row.userId}` }}</span>
      </template>
      <template #messageCount="{ row }">
        <span class="conversations__mono">{{ row.messageCount }}</span>
      </template>
      <template #updatedAt="{ row }">
        <span class="conversations__mono">{{ formatTime(row.updatedAt) }}</span>
      </template>
      <template #actions="{ row }">
        <div class="conversations__actions">
          <button class="conversations__link" type="button" @click="openDetail(row)">查看</button>
          <button
            class="conversations__link conversations__link--danger"
            type="button"
            @click="pendingDelete = row"
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

    <ModalDialog
      v-if="detailLoading || detail"
      title="会话详情"
      width="640px"
      confirm-text="关闭"
      :cancel-text="null"
      @close="closeDetail()"
      @confirm="closeDetail()"
    >
      <template #close-icon><X :size="16" /></template>
      <p v-if="detailLoading" class="conversations__hint">加载中…</p>
      <div v-else-if="detail" class="conversations__detail">
        <p class="conversations__meta">
          {{ detail.ownerName ?? `#${detail.userId}` }} · 共 {{ detail.messages.length }} 条消息 ·
          {{ formatTime(detail.updatedAt) }}
        </p>
        <ol class="conversations__messages">
          <li v-for="message in detail.messages" :key="message.id" class="conversations__message">
            <span class="conversations__role" :class="`conversations__role--${message.role}`">
              {{ ROLE_LABEL[message.role] }}
            </span>
            <p class="conversations__content">{{ message.content }}</p>
            <p v-if="message.sources?.length" class="conversations__tags">
              来源：{{ message.sources.join('、') }}
            </p>
            <p v-if="message.attachments?.length" class="conversations__tags">
              附件：{{ message.attachments.join('、') }}
            </p>
            <p v-if="message.tools?.length" class="conversations__tags">
              工具：{{ message.tools.join('、') }}
            </p>
          </li>
        </ol>
      </div>
    </ModalDialog>

    <ModalDialog
      v-if="pendingDelete"
      title="删除会话"
      confirm-text="删除"
      danger
      :loading="submitting"
      @close="pendingDelete = null"
      @confirm="confirmDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="conversations__confirm">
        确定删除会话「{{ pendingDelete.title }}」？其全部消息会一并清除，操作不可撤销。
      </p>
    </ModalDialog>

    <ModalDialog
      v-if="confirmingBatch"
      title="批量删除会话"
      confirm-text="删除"
      danger
      :loading="submitting"
      @close="confirmingBatch = false"
      @confirm="confirmBatchDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="conversations__confirm">
        确定删除选中的 {{ selectedKeys.length }} 条会话？其全部消息会一并清除，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style src="./conversations.less" lang="less" scoped></style>
