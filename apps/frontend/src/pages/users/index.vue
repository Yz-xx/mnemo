<script setup lang="ts">
import { Plus } from 'lucide-vue-next';
import BatchBar from '@/components/BatchBar';
import DataTable from '@/components/DataTable';
import ModalDialog from '@/components/ModalDialog';
import PageBar from '@/components/PageBar';
import SearchBar from '@/components/SearchBar';
import UserFormDialog from '@/components/UserFormDialog';
import { formatTime } from '@/utils/time';
import { useUsersPage } from './users';

const {
  PAGE_SIZE,
  ROLE_LABEL,
  STATUS_LABEL,
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
  mutating,
  selectedKeys,
  isSelf,
  handleSearch,
  handlePage,
  changeRole,
  toggleStatus,
  clearSelection,
  batchStatus,
  openCreate,
  askDelete,
  openBatchDelete,
  closeDialog,
  handleCreate,
  confirmDelete,
  confirmBatchDelete,
} = useUsersPage();
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

<style src="./users.less" lang="less" scoped></style>
