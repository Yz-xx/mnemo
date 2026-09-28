<script setup lang="ts">
// 新建用户表单：用户名 / 密码 / 角色。校验规则以后端为准（与桌面端注册同一套），
// 这里只拦非空，避免明显无效的请求往返；提交失败由父级经 error 回填，弹窗保留已填内容。
import type { UserRole } from '@/api/types';
import { ref } from 'vue';
import ModalDialog from '../ModalDialog';

withDefaults(defineProps<{ loading?: boolean; error?: string }>(), { loading: false, error: '' });

const emit = defineEmits<{
  close: [];
  submit: [input: { username: string; password: string; role: UserRole }];
}>();

const username = ref('');
const password = ref('');
const role = ref<UserRole>('user');
const localError = ref('');

function handleConfirm(): void {
  const name = username.value.trim();
  if (!name || !password.value) {
    localError.value = '请填写用户名与密码';
    return;
  }
  localError.value = '';
  emit('submit', { username: name, password: password.value, role: role.value });
}
</script>

<template>
  <ModalDialog
    title="新建用户"
    confirm-text="创建"
    :loading="loading"
    @close="emit('close')"
    @confirm="handleConfirm"
  >
    <div class="user-form">
      <label class="user-form__field">
        <span class="user-form__label">用户名</span>
        <input
          v-model="username"
          class="user-form__input"
          type="text"
          placeholder="2-32 位中文、字母、数字或下划线"
        />
      </label>
      <label class="user-form__field">
        <span class="user-form__label">密码</span>
        <input v-model="password" class="user-form__input" type="password" placeholder="6-32 位" />
      </label>
      <label class="user-form__field">
        <span class="user-form__label">角色</span>
        <select v-model="role" class="user-form__input">
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
      </label>
      <p v-if="localError || error" class="user-form__error">{{ localError || error }}</p>
    </div>
  </ModalDialog>
</template>

<style src="./UserFormDialog.less" lang="less" scoped></style>
