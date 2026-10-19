<script setup lang="ts">
import { Plus, Search, X } from 'lucide-vue-next';
import { BatchBar, DataTable, ModalDialog, PageBar, SearchBar } from '@repo/components';
import { formatTime } from '@repo/shared';
import UserFormDialog from '@/components/UserFormDialog';
import { useUsersPage } from './users';

const { filter, table, selection, dialog, cells } = useUsersPage();
</script>

<template>
  <div class="users">
    <div class="users__toolbar">
      <SearchBar
        v-model:keyword="filter.keyword"
        placeholder="搜索用户名"
        @search="filter.handleSearch"
      >
        <template #icon><Search :size="15" /></template>
      </SearchBar>
      <div class="users__toolbar-actions">
        <!-- 批量条并入工具栏行：行高固定，出现/消失不会把下方表格推下去 -->
        <BatchBar
          v-if="selection.selectedKeys.length > 0"
          :count="selection.selectedKeys.length"
          @clear="selection.clearSelection"
        >
          <template #clear-icon><X :size="13" /></template>
          <button
            class="users__link"
            type="button"
            :disabled="selection.mutating"
            @click="selection.batchStatus('banned')"
          >
            批量停用
          </button>
          <button
            class="users__link"
            type="button"
            :disabled="selection.mutating"
            @click="selection.batchStatus('active')"
          >
            批量启用
          </button>
          <button
            class="users__link users__link--danger"
            type="button"
            :disabled="selection.mutating"
            @click="selection.openBatchDelete"
          >
            批量删除
          </button>
        </BatchBar>
        <button class="users__create" type="button" @click="dialog.openCreate">
          <Plus :size="15" />
          <span>新建用户</span>
        </button>
      </div>
    </div>

    <p v-if="table.errorMsg" class="users__error">{{ table.errorMsg }}</p>

    <DataTable
      v-model:selected-keys="selection.selectedKeys"
      selectable
      :columns="table.columns"
      :rows="table.rows"
      :row-key="(row) => row.id"
      :loading="table.loading"
      empty-text="没有匹配的用户"
    >
      <!-- 普通管理员管不到后台账号（列表里也不会有），行内只读展示即可 -->
      <template #role="{ row }">
        <select
          v-if="cells.isSuperAdmin"
          class="users__select"
          :value="row.role"
          :disabled="cells.isSelf(row) || selection.mutating"
          @change="cells.changeRole(row, $event)"
        >
          <option v-for="option in cells.roleOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <span v-else>{{ cells.ROLE_LABEL[row.role] }}</span>
      </template>
      <template #status="{ row }">
        <span class="users__badge" :class="`users__badge--${row.status}`">
          {{ cells.STATUS_LABEL[row.status] }}
        </span>
      </template>
      <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
      <template #actions="{ row }">
        <div class="users__actions">
          <button
            class="users__link"
            type="button"
            :disabled="cells.isSelf(row) || selection.mutating"
            @click="cells.toggleStatus(row)"
          >
            {{ row.status === 'active' ? '停用' : '启用' }}
          </button>
          <button
            class="users__link users__link--danger"
            type="button"
            :disabled="cells.isSelf(row) || selection.mutating"
            @click="dialog.askDelete(row)"
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

    <UserFormDialog
      v-if="dialog.kind === 'create'"
      :loading="dialog.submitting"
      :error="dialog.formError"
      :options="cells.roleOptions"
      @close="dialog.closeDialog"
      @submit="dialog.handleCreate"
    />

    <ModalDialog
      v-if="dialog.kind === 'delete'"
      title="删除用户"
      confirm-text="删除"
      danger
      :loading="dialog.submitting"
      @close="dialog.closeDialog"
      @confirm="dialog.confirmDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="users__confirm">
        确定删除用户「{{
          dialog.selected?.username
        }}」？其登录会话、对话记录与上传文件会一并清理，操作不可撤销。
      </p>
    </ModalDialog>

    <ModalDialog
      v-if="dialog.kind === 'batch-delete'"
      title="批量删除用户"
      confirm-text="删除"
      danger
      :loading="dialog.submitting"
      @close="dialog.closeDialog"
      @confirm="dialog.confirmBatchDelete"
    >
      <template #close-icon><X :size="16" /></template>
      <p class="users__confirm">
        确定删除选中的
        {{ selection.selectedKeys.length }}
        个账号？其登录会话、对话记录与上传文件会一并清理，操作不可撤销。
      </p>
    </ModalDialog>
  </div>
</template>

<style src="./users.less" lang="less" scoped></style>
