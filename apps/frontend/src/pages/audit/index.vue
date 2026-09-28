<script setup lang="ts">
// 操作审计：管理端的每一次写操作都由服务端自动登记，本页只做检索与详情查看。
// 与「API 日志」的分工是范围——这里只留写入动作及其操作人，回溯变更时不必在 GET 里翻找。
import type { AuditLogItem } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import { listAuditLogs } from '@/api/admin';
import DataTable from '@/components/DataTable';
import ModalDialog from '@/components/ModalDialog';
import PageBar from '@/components/PageBar';
import SearchBar from '@/components/SearchBar';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const columns = [
  { key: 'createdAt', label: '时间', width: '170px' },
  { key: 'actor', label: '操作人', width: '140px' },
  { key: 'method', label: '方法', width: '84px' },
  { key: 'path', label: '操作路径' },
  { key: 'status', label: '结果', width: '80px' },
  { key: 'actions', label: '详情', width: '70px', align: 'right' as const },
];

const keyword = ref('');
const page = ref(1);
const rows = ref<AuditLogItem[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMsg = ref('');

/** 详情弹窗中的这一条：为空表示未打开 */
const detail = ref<AuditLogItem | null>(null);

/** 状态色调：2xx 成功、4xx 客户端错误、5xx 服务端错误 */
function statusKindOf(status: number): 'ok' | 'client' | 'server' {
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'ok';
}

/** 操作人展示：超级令牌入口无账号 ID，账号被删后也只剩 ID */
function actorLabel(row: AuditLogItem): string {
  if (row.actorId === null) return '超级令牌';
  return row.actorName ?? `#${row.actorId}`;
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
    { label: '操作人', value: actorLabel(row) },
    { label: '操作', value: `${row.method} ${row.path}` },
    { label: '结果', value: String(row.status) },
    { label: '时间', value: formatTime(row.createdAt) },
    { label: '请求体', value: row.detail ?? '—' },
  ];
});

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    const result = await listAuditLogs({
      keyword: keyword.value.trim(),
      page: page.value,
      pageSize: PAGE_SIZE,
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (e) {
    errorMsg.value = (e as Error).message || '加载操作审计失败';
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

onMounted(() => void load());
</script>

<template>
  <div class="audit">
    <header class="audit__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="audit__lede">管理端的写入操作留档，含被拒绝的尝试，按时间倒序</p>
      <p class="audit__stamp">共 {{ total }} 条</p>
    </header>

    <div class="audit__toolbar reveal" :style="{ '--reveal-index': 1 }">
      <SearchBar v-model:keyword="keyword" placeholder="搜索操作路径" @search="handleSearch" />
    </div>

    <p v-if="errorMsg" class="audit__error">{{ errorMsg }}</p>

    <DataTable
      :columns="columns"
      :rows="rows"
      :row-key="(row) => row.id"
      :loading="loading"
      empty-text="没有匹配的操作记录"
    >
      <template #createdAt="{ row }">
        <span class="audit__mono">{{ formatTime(row.createdAt) }}</span>
      </template>
      <template #actor="{ row }">
        <span class="audit__actor">{{ actorLabel(row) }}</span>
      </template>
      <template #method="{ row }">
        <span class="audit__method">{{ row.method }}</span>
      </template>
      <template #path="{ row }">
        <span class="audit__path" :title="row.path">{{ row.path }}</span>
      </template>
      <template #status="{ row }">
        <span class="audit__status" :class="`audit__status--${statusKindOf(row.status)}`">
          {{ row.status }}
        </span>
      </template>
      <template #actions="{ row }">
        <button class="audit__link" type="button" @click="detail = row">查看</button>
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
      title="操作详情"
      width="560px"
      confirm-text="关闭"
      :cancel-text="null"
      @close="detail = null"
      @confirm="detail = null"
    >
      <dl class="audit__detail">
        <template v-for="field in detailFields" :key="field.label">
          <dt class="audit__detail-label">{{ field.label }}</dt>
          <dd class="audit__detail-value">{{ field.value }}</dd>
        </template>
      </dl>
    </ModalDialog>
  </div>
</template>

<style scoped lang="less">
.audit {
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
    gap: 12px;
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

  // 记录性字段一律走等宽族：时间、状态码纵向对齐，扫读时不必逐字辨认
  &__mono {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: var(--tracking-mono);
  }

  &__actor {
    color: var(--text);
    font-size: 13px;
  }

  &__method {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--tracking-label);
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
