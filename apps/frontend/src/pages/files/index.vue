<script setup lang="ts">
// 文件管理：管理视角列出全部用户的上传文件，可清理。
// 列表只展示元数据（文件名、类型、大小、归属），文件字节留在服务端，不在此页预览。
import type { AdminFileItem } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import { batchDeleteAdminFiles, deleteAdminFile, listAdminFiles } from '@/api/admin';
import BatchBar from '@/components/BatchBar';
import DataTable from '@/components/DataTable';
import ModalDialog from '@/components/ModalDialog';
import PageBar from '@/components/PageBar';
import SearchBar from '@/components/SearchBar';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

/** 字节单位的进位基数：按 1024 递进，与系统文件管理器一致 */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

const columns = [
  { key: 'name', label: '文件名' },
  { key: 'ext', label: '类型', width: '80px' },
  { key: 'size', label: '大小', width: '100px', align: 'right' as const },
  { key: 'owner', label: '归属', width: '140px' },
  { key: 'createdAt', label: '上传时间', width: '170px' },
  { key: 'actions', label: '操作', width: '80px', align: 'right' as const },
];

const keyword = ref('');
const page = ref(1);
const rows = ref<AdminFileItem[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMsg = ref('');

const pendingDelete = ref<AdminFileItem | null>(null);
const confirmingBatch = ref(false);
const submitting = ref(false);

/** 已勾选行的键：翻页、搜索或重新取数后由 load 清空，不做跨页保留 */
const selectedKeys = ref<Array<string | number>>([]);
/** 批量接口要的文件 ID：行键本身就是字符串 ID */
const selectedIds = computed(() => selectedKeys.value.map(String));

/** 人类可读的文件大小：超过 1GB 只到 GB，避免列表出现长串数字 */
function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 字节数不显示小数位，其余保留一位
  return `${unit === 0 ? value : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

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
    const result = await listAdminFiles({
      keyword: keyword.value.trim(),
      page: page.value,
      pageSize: PAGE_SIZE,
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (e) {
    errorMsg.value = (e as Error).message || '加载文件列表失败';
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

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  submitting.value = true;
  try {
    await deleteAdminFile(target.id);
    pendingDelete.value = null;
    await load();
  } catch (e) {
    errorMsg.value = (e as Error).message || '删除文件失败';
    pendingDelete.value = null;
  } finally {
    submitting.value = false;
  }
}

async function confirmBatchDelete(): Promise<void> {
  submitting.value = true;
  try {
    await batchDeleteAdminFiles(selectedIds.value);
    confirmingBatch.value = false;
    await load();
  } catch (e) {
    errorMsg.value = (e as Error).message || '批量删除文件失败';
    confirmingBatch.value = false;
  } finally {
    submitting.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="files">
    <header class="files__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="files__lede">全部账号上传的文件，删除会同时清理服务端存放的原始字节</p>
      <p class="files__stamp">共 {{ total }} 个</p>
    </header>

    <div class="files__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar v-model:keyword="keyword" placeholder="搜索文件名" @search="handleSearch" />
    </div>

    <p v-if="errorMsg" class="files__error">{{ errorMsg }}</p>

    <BatchBar v-if="selectedKeys.length > 0" :count="selectedKeys.length" @clear="clearSelection">
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
        <span class="files__mono">{{ formatSize(row.size) }}</span>
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
      <p class="files__confirm">
        确定删除选中的
        {{ selectedKeys.length }} 个文件？服务端存放的原始字节会一并清除，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style scoped lang="less">
.files {
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

  &__name {
    display: block;
    max-width: 420px;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  // 扩展名走等宽疏排小标：与文件名形成层级差，同时不必为每种类型配图标
  &__badge {
    padding: 2px 7px;
    background-color: var(--bg-active);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }

  &__mono {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: var(--tracking-mono);
  }

  &__link {
    padding: 0;
    background-color: transparent;
    border: none;
    font-size: 13px;

    &--danger {
      color: var(--danger);

      &:hover {
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
