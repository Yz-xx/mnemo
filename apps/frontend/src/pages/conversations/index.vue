<script setup lang="ts">
// 会话管理：管理视角列出全部用户的会话，可查看消息内容、删除整条会话或批量删除。
// 用户的私有会话在这里同样可见——后台需要能核查内容并清理。
import type { AdminConversationDetail, AdminConversationSummary, MessageRole } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import {
  batchDeleteAdminConversations,
  deleteAdminConversation,
  fetchAdminConversation,
  listAdminConversations,
} from '@/api/admin';
import BatchBar from '@/components/BatchBar';
import DataTable from '@/components/DataTable';
import ModalDialog from '@/components/ModalDialog';
import PageBar from '@/components/PageBar';
import SearchBar from '@/components/SearchBar';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const ROLE_LABEL: Record<MessageRole, string> = { user: '用户', assistant: '助手', system: '系统' };

const columns = [
  { key: 'title', label: '标题' },
  { key: 'owner', label: '归属', width: '140px' },
  { key: 'messageCount', label: '消息数', width: '90px', align: 'right' as const },
  { key: 'updatedAt', label: '最近更新', width: '170px' },
  { key: 'actions', label: '操作', width: '120px', align: 'right' as const },
];

const keyword = ref('');
const page = ref(1);
const rows = ref<AdminConversationSummary[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMsg = ref('');

/** 详情弹窗：先开窗再取内容，避免点击后界面无反馈 */
const detail = ref<AdminConversationDetail | null>(null);
const detailLoading = ref(false);

const pendingDelete = ref<AdminConversationSummary | null>(null);
const confirmingBatch = ref(false);
const submitting = ref(false);

/** 已勾选行的键：翻页、搜索或重新取数后由 load 清空，不做跨页保留 */
const selectedKeys = ref<Array<string | number>>([]);
/** 批量接口要的会话 ID：行键本身就是字符串 ID */
const selectedIds = computed(() => selectedKeys.value.map(String));

/** 时间按本地时区展示：后端给的是 UTC ISO 串，直接截断会少 8 小时 */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  // 选择随列表内容失效：翻页、搜索、重新取数后都不保留已勾选项
  selectedKeys.value = [];
  try {
    const result = await listAdminConversations({
      keyword: keyword.value.trim(),
      page: page.value,
      pageSize: PAGE_SIZE,
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (e) {
    errorMsg.value = (e as Error).message || '加载会话列表失败';
  } finally {
    loading.value = false;
  }
}

function handleSearch(): void {
  page.value = 1;
  void load();
}

function handlePage(next: number): void {
  page.value = next;
  void load();
}

function clearSelection(): void {
  selectedKeys.value = [];
}

/** 关闭详情：两个状态必须一并复位，否则「加载中关闭」时弹窗仍挂在 v-if 上 */
function closeDetail(): void {
  detailLoading.value = false;
  detail.value = null;
}

async function openDetail(row: AdminConversationSummary): Promise<void> {
  detailLoading.value = true;
  detail.value = null;
  errorMsg.value = '';
  try {
    const result = await fetchAdminConversation(row.id);
    // 请求返回前用户可能已关闭弹窗：此时不再写回，否则弹窗会自己弹回来
    if (detailLoading.value) detail.value = result;
  } catch (e) {
    errorMsg.value = (e as Error).message || '加载会话详情失败';
  } finally {
    detailLoading.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  submitting.value = true;
  try {
    await deleteAdminConversation(target.id);
    pendingDelete.value = null;
    await load();
  } catch (e) {
    errorMsg.value = (e as Error).message || '删除会话失败';
    pendingDelete.value = null;
  } finally {
    submitting.value = false;
  }
}

async function confirmBatchDelete(): Promise<void> {
  submitting.value = true;
  try {
    await batchDeleteAdminConversations(selectedIds.value);
    confirmingBatch.value = false;
    await load();
  } catch (e) {
    errorMsg.value = (e as Error).message || '批量删除会话失败';
    confirmingBatch.value = false;
  } finally {
    submitting.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="conversations">
    <header class="conversations__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="conversations__lede">全部账号的对话记录，可展开核查消息内容</p>
      <p class="conversations__stamp">共 {{ total }} 条</p>
    </header>

    <div class="conversations__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar v-model:keyword="keyword" placeholder="搜索会话标题" @search="handleSearch" />
    </div>

    <p v-if="errorMsg" class="conversations__error">{{ errorMsg }}</p>

    <BatchBar v-if="selectedKeys.length > 0" :count="selectedKeys.length" @clear="clearSelection">
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
      <p class="conversations__confirm">
        确定删除选中的 {{ selectedKeys.length }} 条会话？其全部消息会一并清除，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style scoped lang="less">
.conversations {
  display: flex;
  flex-direction: column;
  gap: 16px;

  &__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
  }

  &__lede {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
  }

  &__stamp {
    margin: 0;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--tracking-mono);
  }

  &__error {
    margin: 0;
    padding: 10px 14px;
    background-color: var(--danger-soft);
    border-left: 2px solid var(--danger);
    border-radius: var(--radius);
    color: var(--danger-strong);
    font-size: 13px;
  }

  // 记录性字段一律走等宽族，与路径、时间类信息保持一致
  &__mono {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: var(--tracking-mono);
  }

  &__title {
    display: block;
    max-width: 420px;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }

  &__link {
    padding: 0;
    background-color: transparent;
    border: none;
    color: var(--primary-strong);
    font-size: 13px;

    &:hover {
      text-decoration: underline;
    }

    &--danger {
      color: var(--danger);

      &:hover {
        color: var(--danger-strong);
      }
    }
  }

  &__hint {
    margin: 0;
    color: var(--text-faint);
    font-size: 13px;
  }

  &__detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__meta {
    margin: 0;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--tracking-mono);
  }

  &__messages {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-height: 52vh;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  // 消息块靠左侧竖线与角色标签区分层次，不用气泡：后台读的是内容而不是对话观感
  &__message {
    padding-left: 12px;
    border-left: 2px solid var(--border);
  }

  &__role {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);

    &--user {
      color: var(--primary-strong);
    }

    &--assistant {
      color: var(--text-faint);
    }

    &--system {
      color: var(--accent-strong);
    }
  }

  &__content {
    margin: 4px 0 0;
    color: var(--text);
    font-size: 13px;
    line-height: 1.65;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  &__tags {
    margin: 4px 0 0;
    color: var(--text-faint);
    font-size: 12px;
  }

  &__confirm {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.6;
  }
}
</style>
