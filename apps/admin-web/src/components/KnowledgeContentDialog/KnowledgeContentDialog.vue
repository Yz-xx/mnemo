<script setup lang="ts">
// 文档查看与编辑弹窗：查看态展示原文（旧文档为分片拼接，带提示），确认按钮切到编辑态；
// 编辑态提交整体替换（服务端重切分重向量化）。editing 由父级控制：
// 保存成功后父级回灌新内容并退出编辑态，失败时保持编辑态并经 error 显示原因。
import type { AdminKnowledgeContent } from '@/api/types';
import { X } from 'lucide-vue-next';
import { ref, watch } from 'vue';
import { ModalDialog } from '@mnemo/components';
import { formatTime } from '@mnemo/shared';

const props = withDefaults(
  defineProps<{
    initial: AdminKnowledgeContent;
    editing?: boolean;
    loading?: boolean;
    error?: string;
  }>(),
  { editing: false, loading: false, error: '' },
);

const emit = defineEmits<{
  close: [];
  edit: [];
  submit: [input: { title: string; content: string }];
}>();

const title = ref(props.initial.document.title);
const content = ref(props.initial.content);
const localError = ref('');

// 保存成功后父级回灌新内容：跟随重置表单并清空本地校验错误
watch(
  () => props.initial,
  (value) => {
    title.value = value.document.title;
    content.value = value.content;
    localError.value = '';
  },
);

function handleConfirm(): void {
  if (!props.editing) {
    emit('edit');
    return;
  }
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
    :title="editing ? '编辑文档' : '查看文档'"
    :confirm-text="editing ? '保存' : '编辑'"
    :cancel-text="null"
    width="640px"
    :loading="loading"
    @close="emit('close')"
    @confirm="handleConfirm"
  >
    <template #close-icon><X :size="16" /></template>
    <div v-if="!editing" class="knowledge-content">
      <p class="knowledge-content__meta">
        <span>分片 {{ initial.document.chunks }} 段</span>
        <span v-if="initial.updatedAt">最后编辑 {{ formatTime(initial.updatedAt) }}</span>
        <span v-else>入库 {{ formatTime(initial.document.createdAt) }}</span>
      </p>
      <p v-if="initial.source === 'stitched'" class="knowledge-content__hint">
        该文档入库早于原文存档，以下为分片拼接的近似内容，保存一次编辑即留存正式原文。
      </p>
      <pre class="knowledge-content__body">{{ initial.content }}</pre>
    </div>

    <div v-else class="knowledge-content">
      <label class="knowledge-content__field">
        <span class="knowledge-content__label">标题</span>
        <input
          v-model="title"
          class="knowledge-content__input"
          type="text"
          placeholder="留空则记为「未命名文档」"
        />
      </label>
      <label class="knowledge-content__field">
        <span class="knowledge-content__label">内容</span>
        <textarea
          v-model="content"
          class="knowledge-content__input knowledge-content__input--area"
          rows="12"
          placeholder="保存时会按新内容重新切分并向量化"
        />
      </label>
      <p v-if="localError || error" class="knowledge-content__error">
        {{ localError || error }}
      </p>
    </div>
  </ModalDialog>
</template>

<style src="./KnowledgeContentDialog.less" lang="less" scoped></style>
