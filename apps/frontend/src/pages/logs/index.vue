<script setup lang="ts">
// API 日志：服务端在响应结束时把每个请求的汇总落库，本页只做检索与详情查看。
// 过滤三个维度（路径关键词、请求方法、状态档位）都是服务端能力，前端不本地过滤，
// 避免列表与总数对不上。
import type { ApiLogItem, ApiLogStatusKind } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import { listApiLogs } from '@/api/admin';
import DataTable from '@/components/DataTable';
import ModalDialog from '@/components/ModalDialog';
import PageBar from '@/components/PageBar';
import SearchBar from '@/components/SearchBar';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

/** 与后端 METHODS 白名单取齐：下拉以外的取值服务端会按「不限」处理 */
const METHOD_OPTIONS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

const STATUS_OPTIONS: { value: ApiLogStatusKind; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'client', label: '4xx 客户端错误' },
  { value: 'server', label: '5xx 服务端错误' },
];

const columns = [
  { key: 'createdAt', label: '时间', width: '170px' },
  { key: 'method', label: '方法', width: '84px' },
  { key: 'path', label: '路径' },
  { key: 'status', label: '状态', width: '80px' },
  { key: 'durationMs', label: '耗时', width: '90px', align: 'right' as const },
  { key: 'userId', label: '用户', width: '80px', align: 'right' as const },
  { key: 'actions', label: '详情', width: '70px', align: 'right' as const },
];

const keyword = ref('');
const method = ref('');
const statusKind = ref<ApiLogStatusKind>('all');
const page = ref(1);
const rows = ref<ApiLogItem[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMsg = ref('');

/** 详情弹窗中的这一条：为空表示未打开 */
const detail = ref<ApiLogItem | null>(null);

/** 状态色调：2xx 成功、4xx 客户端错误、5xx 服务端错误 */
function statusKindOf(status: number): 'ok' | 'client' | 'server' {
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'ok';
}

/** 记录时间按本地时区展示：后端给的是 UTC ISO 串，直接截断会少 8 小时 */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

/** 详情字段：值可能为空，统一用「—」占位，避免弹窗出现空白行 */
const detailFields = computed(() => {
  const row = detail.value;
  if (!row) return [];
  return [
    { label: '请求 ID', value: row.requestId },
    { label: '请求', value: `${row.method} ${row.path}` },
    { label: '状态与耗时', value: `${row.status} · ${row.durationMs} ms` },
    { label: '用户', value: row.userId === null ? '未登录 / 超级令牌' : `#${row.userId}` },
    { label: '时间', value: formatTime(row.createdAt) },
    { label: '查询串', value: row.queryParams ?? '—' },
    { label: '请求体', value: row.requestBody ?? '—' },
    { label: '响应体', value: row.responseBody ?? '—' },
    { label: '错误', value: row.error ?? '—' },
  ];
});

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    const result = await listApiLogs({
      keyword: keyword.value.trim(),
      method: method.value,
      status: statusKind.value,
      page: page.value,
      pageSize: PAGE_SIZE,
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (e) {
    errorMsg.value = (e as Error).message || '加载接口日志失败';
  } finally {
    loading.value = false;
  }
}

/** 改动任一过滤条件都回到第一页：停在旧页码上容易看到空列表 */
function handleSearch(): void {
  page.value = 1;
  void load();
}

function handlePage(next: number): void {
  page.value = next;
  void load();
}

onMounted(() => void load());
</script>

<template>
  <div class="logs">
    <header class="logs__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="logs__lede">每次请求的路径、状态与耗时，按时间倒序留档</p>
      <p class="logs__stamp">共 {{ total }} 条</p>
    </header>

    <div class="logs__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar v-model:keyword="keyword" placeholder="搜索请求路径" @search="handleSearch" />
      <div class="logs__filters">
        <select v-model="method" class="logs__select" @change="handleSearch">
          <option value="">全部方法</option>
          <option v-for="item in METHOD_OPTIONS" :key="item" :value="item">{{ item }}</option>
        </select>
        <select v-model="statusKind" class="logs__select" @change="handleSearch">
          <option v-for="item in STATUS_OPTIONS" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select>
      </div>
    </div>

    <p v-if="errorMsg" class="logs__error">{{ errorMsg }}</p>

    <DataTable
      :columns="columns"
      :rows="rows"
      :row-key="(row) => row.id"
      :loading="loading"
      empty-text="没有匹配的接口日志"
    >
      <template #createdAt="{ row }">
        <span class="logs__mono">{{ formatTime(row.createdAt) }}</span>
      </template>
      <template #method="{ row }">
        <span class="logs__method">{{ row.method }}</span>
      </template>
      <template #path="{ row }">
        <span class="logs__path" :title="row.path">{{ row.path }}</span>
      </template>
      <template #status="{ row }">
        <span class="logs__status" :class="`logs__status--${statusKindOf(row.status)}`">
          {{ row.status }}
        </span>
      </template>
      <template #durationMs="{ row }">
        <span class="logs__mono">{{ row.durationMs }} ms</span>
      </template>
      <template #userId="{ row }">
        <span class="logs__mono">{{ row.userId ?? '—' }}</span>
      </template>
      <template #actions="{ row }">
        <button class="logs__link" type="button" @click="detail = row">查看</button>
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
      v-if="detail"
      title="请求详情"
      width="560px"
      confirm-text="关闭"
      :cancel-text="null"
      @close="detail = null"
      @confirm="detail = null"
    >
      <dl class="logs__detail">
        <template v-for="field in detailFields" :key="field.label">
          <dt class="logs__detail-label">{{ field.label }}</dt>
          <dd class="logs__detail-value">{{ field.value }}</dd>
        </template>
      </dl>
    </ModalDialog>
  </div>
</template>

<style scoped lang="less">
.logs {
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

  &__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  &__filters {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__select {
    height: 32px;
    padding: 0 8px;
    background-color: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 13px;
    outline: none;
    transition: border-color var(--transition);

    &:focus {
      border-color: var(--primary);
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

  // 记录性字段一律走等宽族：路径、耗时、状态码纵向对齐，扫读时不必逐字辨认
  &__mono {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: var(--tracking-mono);
  }

  &__method {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--tracking-label);
    color: var(--text-muted);
  }

  &__path {
    display: block;
    max-width: 520px;
    overflow: hidden;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  // 状态码按语义分色：成功中性、客户端错误示警、服务端错误用危险色
  &__status {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;

    &--ok {
      color: var(--text-muted);
    }

    &--client {
      color: var(--warning-strong);
    }

    &--server {
      color: var(--danger-strong);
    }
  }

  &__link {
    padding: 0;
    background-color: transparent;
    border: none;
    color: var(--primary-strong);
    font-size: 13px;
    transition: color var(--transition);

    &:hover {
      text-decoration: underline;
    }
  }

  &__detail {
    display: grid;
    grid-template-columns: 84px 1fr;
    gap: 8px 14px;
    margin: 0;
  }

  &__detail-label {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--tracking-label);
    line-height: 1.7;
  }

  &__detail-value {
    margin: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.7;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
}
</style>
