<script setup lang="ts">
// 知识库管理：管理视角的文档列表（含各用户的私有文档）+ 新增全局文档 + 单条与批量删除。
// 文档存在 LanceDB 而非 MySQL，后端在内存里过滤与分页，前端按同一套翻页交互处理。
import type { AdminKnowledgeDocument, KnowledgeScope } from '@/api/types';
import { Plus } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import {
  batchDeleteKnowledgeDocuments,
  createGlobalDocument,
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
} from '@/api/admin';
import BatchBar from '@/components/BatchBar';
import DataTable from '@/components/DataTable';
import KnowledgeFormDialog from '@/components/KnowledgeFormDialog';
import ModalDialog from '@/components/ModalDialog';
import PageBar from '@/components/PageBar';
import SearchBar from '@/components/SearchBar';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const SCOPE_LABEL: Record<KnowledgeScope, string> = { global: '全局', private: '私有' };

const columns = [
  { key: 'title', label: '标题' },
  { key: 'scope', label: '范围', width: '90px' },
  { key: 'owner', label: '归属', width: '140px' },
  { key: 'chunks', label: '片段', width: '80px', align: 'right' as const },
  { key: 'createdAt', label: '入库时间', width: '170px' },
  { key: 'actions', label: '操作', width: '80px', align: 'right' as const },
];

const keyword = ref('');
const page = ref(1);
const rows = ref<AdminKnowledgeDocument[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMsg = ref('');

/** 当前弹窗：同一时刻只可能开一个 */
const dialog = ref<'create' | 'delete' | 'batch-delete' | null>(null);
const selected = ref<AdminKnowledgeDocument | null>(null);
const submitting = ref(false);
const formError = ref('');

/** 已勾选行的键：翻页、搜索或重新取数后由 load 清空，不做跨页保留 */
const selectedKeys = ref<Array<string | number>>([]);
/** 批量接口要的文档 ID：行键本身就是字符串 ID */
const selectedIds = computed(() => selectedKeys.value.map(String));

/** 入库时间按本地时区展示：后端给的是 UTC ISO 串，直接截断会少 8 小时 */
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
    const result = await listKnowledgeDocuments({
      keyword: keyword.value.trim(),
      page: page.value,
      pageSize: PAGE_SIZE,
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (e) {
    errorMsg.value = (e as Error).message || '加载文档列表失败';
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

function openCreate(): void {
  formError.value = '';
  dialog.value = 'create';
}

function askDelete(row: AdminKnowledgeDocument): void {
  selected.value = row;
  dialog.value = 'delete';
}

function openBatchDelete(): void {
  dialog.value = 'batch-delete';
}

function closeDialog(): void {
  dialog.value = null;
  selected.value = null;
}

async function handleCreate(input: { title: string; content: string }): Promise<void> {
  submitting.value = true;
  formError.value = '';
  try {
    await createGlobalDocument(input);
    closeDialog();
    page.value = 1;
    await load();
  } catch (e) {
    // 保留弹窗与已填内容，便于改完环境后直接重试
    formError.value = (e as Error).message || '文档入库失败';
  } finally {
    submitting.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  const target = selected.value;
  if (!target) return;
  submitting.value = true;
  try {
    await deleteKnowledgeDocument(target.id);
    closeDialog();
    await load();
  } catch (e) {
    errorMsg.value = (e as Error).message || '删除文档失败';
    closeDialog();
  } finally {
    submitting.value = false;
  }
}

async function confirmBatchDelete(): Promise<void> {
  submitting.value = true;
  try {
    await batchDeleteKnowledgeDocuments(selectedIds.value);
    closeDialog();
    await load();
  } catch (e) {
    errorMsg.value = (e as Error).message || '批量删除文档失败';
    closeDialog();
  } finally {
    submitting.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="knowledge">
    <div class="knowledge__toolbar">
      <SearchBar v-model:keyword="keyword" placeholder="搜索文档标题" @search="handleSearch" />
      <button class="knowledge__create" type="button" @click="openCreate">
        <Plus :size="15" />
        <span>新增全局文档</span>
      </button>
    </div>

    <p v-if="errorMsg" class="knowledge__error">{{ errorMsg }}</p>

    <BatchBar v-if="selectedKeys.length > 0" :count="selectedKeys.length" @clear="clearSelection">
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
        <button
          class="knowledge__link knowledge__link--danger"
          type="button"
          @click="askDelete(row)"
        >
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

    <KnowledgeFormDialog
      v-if="dialog === 'create'"
      :loading="submitting"
      :error="formError"
      @close="closeDialog"
      @submit="handleCreate"
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
      <p class="knowledge__confirm">
        确定删除选中的 {{ selectedKeys.length }} 篇文档？其全部向量片段会一并清除，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style scoped lang="less">
.knowledge {
  display: flex;
  flex-direction: column;
  gap: 16px;

  &__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  &__create {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 14px;
    background-color: var(--primary-strong);
    border: 1px solid var(--primary-strong);
    border-radius: var(--radius);
    color: var(--text-inverse);
    font-size: 13px;
    letter-spacing: var(--tracking-label);
    transition: filter var(--transition);

    &:hover:not(:disabled) {
      filter: brightness(0.92);
    }
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

  // 范围徽标：深色语义字配浅底，两个组合对比度均在 4.5:1 以上
  &__badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 12px;

    &--global {
      background-color: var(--primary-soft);
      color: var(--primary-strong);
    }

    &--private {
      background-color: var(--bg-active);
      color: var(--text-muted);
    }
  }

  &__owner--none {
    color: var(--text-faint);
  }

  &__link {
    padding: 0;
    background-color: transparent;
    border: none;
    font-size: 13px;

    &--danger {
      color: var(--danger);

      &:hover:not(:disabled) {
        color: var(--danger-strong);
        text-decoration: underline;
      }
    }
  }

  &__confirm {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.6;
  }
}
</style>
