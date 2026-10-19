<script setup lang="ts">
import { Search, X } from 'lucide-vue-next';
import { BatchBar, DataTable, ModalDialog, PageBar, SearchBar } from '@repo/components';
import { formatTime } from '@repo/shared';
import { useConversationsPage } from './conversations';

const { filter, table, selection, detail, dialog } = useConversationsPage();
</script>

<template>
  <div class="conversations">
    <header class="conversations__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="conversations__lede">全部账号的对话记录，可展开核查消息内容</p>
      <p class="conversations__stamp">共 {{ table.total }} 条</p>
    </header>

    <div class="conversations__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar
        v-model:keyword="filter.keyword"
        placeholder="搜索会话标题"
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
          class="conversations__link conversations__link--danger"
          type="button"
          @click="dialog.batchOpen = true"
        >
          批量删除
        </button>
      </BatchBar>
    </div>

    <p v-if="table.errorMsg" class="conversations__error">{{ table.errorMsg }}</p>

    <DataTable
      v-model:selected-keys="selection.selectedKeys"
      selectable
      :columns="table.columns"
      :rows="table.rows"
      :row-key="(row) => row.id"
      :loading="table.loading"
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
          <button class="conversations__link" type="button" @click="detail.open(row)">查看</button>
          <button
            class="conversations__link conversations__link--danger"
            type="button"
            @click="dialog.target = row"
          >
            删除
          </button>
        </div>
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
      v-if="detail.loading || detail.content"
      title="会话详情"
      width="640px"
      confirm-text="关闭"
      :cancel-text="null"
      @close="detail.close()"
      @confirm="detail.close()"
    >
      <template #close-icon><X :size="16" /></template>
      <p v-if="detail.loading" class="conversations__hint">加载中…</p>
      <div v-else-if="detail.content" class="conversations__detail">
        <p class="conversations__meta">
          {{ detail.content.ownerName ?? `#${detail.content.userId}` }} · 共
          {{ detail.content.messages.length }} 条消息 · {{ formatTime(detail.content.updatedAt) }}
        </p>
        <ol class="conversations__messages">
          <li
            v-for="message in detail.content.messages"
            :key="message.id"
            class="conversations__message"
          >
            <span class="conversations__role" :class="`conversations__role--${message.role}`">
              {{ detail.ROLE_LABEL[message.role] }}
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
      v-if="dialog.target"
      title="删除会话"
      confirm-text="删除"
      danger
      :loading="dialog.submitting"
      @close="dialog.target = null"
      @confirm="dialog.confirmDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="conversations__confirm">
        确定删除会话「{{ dialog.target.title }}」？其全部消息会一并清除，操作不可撤销。
      </p>
    </ModalDialog>

    <ModalDialog
      v-if="dialog.batchOpen"
      title="批量删除会话"
      confirm-text="删除"
      danger
      :loading="dialog.submitting"
      @close="dialog.batchOpen = false"
      @confirm="dialog.confirmBatch"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="conversations__confirm">
        确定删除选中的
        {{ selection.selectedKeys.length }} 条会话？其全部消息会一并清除，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style src="./conversations.less" lang="less" scoped></style>
