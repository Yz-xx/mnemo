<script setup lang="ts">
// 新增全局文档表单：标题 + 正文。入库会同步切分与向量化，成功后由父级回读列表；
// 失败信息经 error 回填，弹窗保留已填内容——向量化服务未起来这类问题修好环境即可重试。
import { X } from 'lucide-vue-next';
import { ref } from 'vue';
import { ModalDialog } from '@mnemo/components';

withDefaults(defineProps<{ loading?: boolean; error?: string }>(), { loading: false, error: '' });

const emit = defineEmits<{
  close: [];
  submit: [input: { title: string; content: string }];
}>();

const title = ref('');
const content = ref('');
const localError = ref('');

function handleConfirm(): void {
  if (!content.value.trim()) {
    localError.value = '请填写文档内容';
    return;
  }
  localError.value = '';
  emit('submit', { title: title.value.trim(), content: content.value.trim() });
}
</script>

<template>
  <ModalDialog
    title="新增全局文档"
    confirm-text="入库"
    width="520px"
    :loading="loading"
    @close="emit('close')"
    @confirm="handleConfirm"
  >
    <template #close-icon><X :size="16" /></template>
    <div class="knowledge-form">
      <label class="knowledge-form__field">
        <span class="knowledge-form__label">标题</span>
        <input
          v-model="title"
          class="knowledge-form__input"
          type="text"
          placeholder="留空则记为「未命名文档」"
        />
      </label>
      <label class="knowledge-form__field">
        <span class="knowledge-form__label">内容</span>
        <textarea
          v-model="content"
          class="knowledge-form__input knowledge-form__input--area"
          rows="10"
          placeholder="粘贴或输入文档正文，入库时会自动切分并向量化"
        />
      </label>
      <p v-if="localError || error" class="knowledge-form__error">{{ localError || error }}</p>
    </div>
  </ModalDialog>
</template>

<style src="./KnowledgeFormDialog.less" lang="less" scoped></style>
