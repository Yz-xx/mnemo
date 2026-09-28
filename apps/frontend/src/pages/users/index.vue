<script setup lang="ts">
// 用户管理：搜索 + 分页列表 + 行内改角色 / 状态 + 新建、单条与批量删除。
// “不能动自己、不能清空管理员”这两条自锁规则由服务端判定（批量时按整批一次算），
// 前端只做按钮禁用与错误回显，避免两端各写一套规则后互相打架。
import type { AdminUser, UserRole, UserStatus } from '@/api/types';
import { Plus } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import {
  batchDeleteUsers,
  batchUpdateUserStatus,
  createUser,
  deleteUser,
  listUsers,
  updateUser,
} from '@/api/admin';
import BatchBar from '@/components/BatchBar';
import DataTable from '@/components/DataTable';
import ModalDialog from '@/components/ModalDialog';
import PageBar from '@/components/PageBar';
import SearchBar from '@/components/SearchBar';
import UserFormDialog from '@/components/UserFormDialog';
import { useAuthStore } from '@/stores/auth';

/** 每页条数：与后端 DEFAULT_PAGE_SIZE 取齐 */
const PAGE_SIZE = 20;

const ROLE_LABEL: Record<UserRole, string> = { admin: '管理员', user: '普通用户' };
const STATUS_LABEL: Record<UserStatus, string> = { active: '正常', banned: '已停用' };

const auth = useAuthStore();

const columns = [
  { key: 'id', label: 'ID', width: '64px' },
  { key: 'username', label: '用户名' },
  { key: 'role', label: '角色', width: '120px' },
  { key: 'status', label: '状态', width: '90px' },
  { key: 'createdAt', label: '创建时间', width: '170px' },
  { key: 'actions', label: '操作', width: '120px', align: 'right' as const },
];

const keyword = ref('');
const page = ref(1);
const rows = ref<AdminUser[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMsg = ref('');

/** 当前弹窗：同一时刻只可能开一个 */
const dialog = ref<'create' | 'delete' | 'batch-delete' | null>(null);
const selected = ref<AdminUser | null>(null);
const submitting = ref(false);
const formError = ref('');

/** 行内变更进行中：锁住所有操作，避免并发请求把列表刷成中间态 */
const mutating = ref(false);

/** 已勾选行的键：翻页、搜索或重新取数后由 load 清空，不做跨页保留 */
const selectedKeys = ref<Array<string | number>>([]);
/** 批量接口要的账号 ID：行键本就是 id，这里统一收窄为 number */
const selectedIds = computed(() => selectedKeys.value.map(Number));

/** 当前登录账号所在行：自锁规则下这些按钮对它禁用 */
function isSelf(row: AdminUser): boolean {
  return auth.user?.id === row.id;
}

/** 创建时间按本地时区展示：后端给的是 UTC ISO 串，直接截断会少 8 小时 */
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
    const result = await listUsers({
      keyword: keyword.value.trim(),
      page: page.value,
      pageSize: PAGE_SIZE,
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (e) {
    errorMsg.value = (e as Error).message || '加载用户列表失败';
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

/** 行内变更的统一出口：无论成败都回读一次，保证控件显示与后端一致 */
async function mutate(action: () => Promise<unknown>, fallback: string): Promise<void> {
  mutating.value = true;
  errorMsg.value = '';
  try {
    await action();
  } catch (e) {
    errorMsg.value = (e as Error).message || fallback;
  } finally {
    mutating.value = false;
    await load();
  }
}

function changeRole(row: AdminUser, event: Event): void {
  const role = (event.target as HTMLSelectElement).value as UserRole;
  void mutate(() => updateUser(row.id, { role }), '变更角色失败');
}

function toggleStatus(row: AdminUser): void {
  const status: UserStatus = row.status === 'active' ? 'banned' : 'active';
  void mutate(() => updateUser(row.id, { status }), '变更状态失败');
}

function clearSelection(): void {
  selectedKeys.value = [];
}

/** 批量停用 / 启用：可逆操作不弹确认，整批规则由服务端判定 */
function batchStatus(status: UserStatus): void {
  void mutate(() => batchUpdateUserStatus(selectedIds.value, status), '批量变更状态失败');
}

function openCreate(): void {
  formError.value = '';
  dialog.value = 'create';
}

function askDelete(row: AdminUser): void {
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

async function handleCreate(input: {
  username: string;
  password: string;
  role: UserRole;
}): Promise<void> {
  submitting.value = true;
  formError.value = '';
  try {
    await createUser(input);
    closeDialog();
    page.value = 1;
    await load();
  } catch (e) {
    // 保留弹窗与已填内容：用户名被占用这类错误改一个字段就能重试
    formError.value = (e as Error).message || '创建用户失败';
  } finally {
    submitting.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  const target = selected.value;
  if (!target) return;
  submitting.value = true;
  try {
    await deleteUser(target.id);
    closeDialog();
    await load();
  } catch (e) {
    errorMsg.value = (e as Error).message || '删除用户失败';
    closeDialog();
  } finally {
    submitting.value = false;
  }
}

async function confirmBatchDelete(): Promise<void> {
  submitting.value = true;
  try {
    await batchDeleteUsers(selectedIds.value);
    closeDialog();
    await load();
  } catch (e) {
    errorMsg.value = (e as Error).message || '批量删除用户失败';
    closeDialog();
  } finally {
    submitting.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="users">
    <div class="users__toolbar">
      <SearchBar v-model:keyword="keyword" placeholder="搜索用户名" @search="handleSearch" />
      <button class="users__create" type="button" @click="openCreate">
        <Plus :size="15" />
        <span>新建用户</span>
      </button>
    </div>

    <p v-if="errorMsg" class="users__error">{{ errorMsg }}</p>

    <BatchBar v-if="selectedKeys.length > 0" :count="selectedKeys.length" @clear="clearSelection">
      <button class="users__link" type="button" :disabled="mutating" @click="batchStatus('banned')">
        批量停用
      </button>
      <button class="users__link" type="button" :disabled="mutating" @click="batchStatus('active')">
        批量启用
      </button>
      <button
        class="users__link users__link--danger"
        type="button"
        :disabled="mutating"
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
      empty-text="没有匹配的用户"
    >
      <template #role="{ row }">
        <select
          class="users__select"
          :value="row.role"
          :disabled="isSelf(row) || mutating"
          @change="changeRole(row, $event)"
        >
          <option value="user">{{ ROLE_LABEL.user }}</option>
          <option value="admin">{{ ROLE_LABEL.admin }}</option>
        </select>
      </template>
      <template #status="{ row }">
        <span class="users__badge" :class="`users__badge--${row.status}`">
          {{ STATUS_LABEL[row.status] }}
        </span>
      </template>
      <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
      <template #actions="{ row }">
        <div class="users__actions">
          <button
            class="users__link"
            type="button"
            :disabled="isSelf(row) || mutating"
            @click="toggleStatus(row)"
          >
            {{ row.status === 'active' ? '停用' : '启用' }}
          </button>
          <button
            class="users__link users__link--danger"
            type="button"
            :disabled="isSelf(row) || mutating"
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

    <UserFormDialog
      v-if="dialog === 'create'"
      :loading="submitting"
      :error="formError"
      @close="closeDialog"
      @submit="handleCreate"
    />

    <ModalDialog
      v-if="dialog === 'delete'"
      title="删除用户"
      confirm-text="删除"
      danger
      :loading="submitting"
      @close="closeDialog"
      @confirm="confirmDelete"
    >
      <p class="users__confirm">
        确定删除用户「{{
          selected?.username
        }}」？其登录会话、对话记录与上传文件会一并清理，操作不可撤销。
      </p>
    </ModalDialog>

    <ModalDialog
      v-if="dialog === 'batch-delete'"
      title="批量删除用户"
      confirm-text="删除"
      danger
      :loading="submitting"
      @close="closeDialog"
      @confirm="confirmBatchDelete"
    >
      <p class="users__confirm">
        确定删除选中的
        {{ selectedKeys.length }} 个账号？其登录会话、对话记录与上传文件会一并清理，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style scoped lang="less">
.users {
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

  &__select {
    height: 28px;
    padding: 0 8px;
    background-color: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 13px;
    outline: none;
    transition: border-color var(--transition);

    &:focus {
      border-color: var(--primary);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
  }

  // 状态徽标：深色语义字 + 浅色底，两个组合对比度均在 4.5:1 以上
  &__badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 12px;

    &--active {
      background-color: var(--success-soft);
      color: var(--success-strong);
    }

    &--banned {
      background-color: var(--danger-soft);
      color: var(--danger-strong);
    }
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
    transition: color var(--transition);

    &:hover:not(:disabled) {
      text-decoration: underline;
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    &--danger {
      color: var(--danger);

      &:hover:not(:disabled) {
        color: var(--danger-strong);
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
