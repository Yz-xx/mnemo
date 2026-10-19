<script setup lang="ts">
import type { KnowledgePanelProps } from './useKnowledgePanel';
import { useKnowledgePanel } from './useKnowledgePanel';

const props = defineProps<KnowledgePanelProps>();

const { form, list } = useKnowledgePanel(props);
</script>

<template>
  <section class="knowledge__body">
    <label class="field">
      <span class="field__label">文档标题</span>
      <input v-model="form.title" class="field__input" placeholder="例如：产品说明书" />
    </label>
    <label class="field">
      <span class="field__label">文档内容</span>
      <textarea
        v-model="form.content"
        class="field__input field__input--area"
        rows="6"
        placeholder="粘贴需要入库的文本内容"
      />
    </label>
    <button
      class="btn btn--primary"
      :disabled="form.busy || !form.content.trim()"
      @click="form.addDocument"
    >
      {{ form.busy ? '处理中…' : '加入知识库' }}
    </button>
    <p v-if="list.notice" class="knowledge__hint">{{ list.notice }}</p>

    <ul class="doc-list">
      <li v-for="item in list.documents" :key="item.id" class="doc">
        <div>
          <div class="doc__title">{{ item.title }}</div>
          <div class="doc__meta">{{ item.chunks }} 个片段</div>
        </div>
        <button class="icon-btn" title="删除文档" @click="list.removeDocument(item.id)">×</button>
      </li>
    </ul>
    <p v-if="list.documents.length === 0 && !list.notice" class="knowledge__hint">知识库为空</p>
  </section>
</template>

<style src="./KnowledgePanel.less" lang="less" scoped></style>
