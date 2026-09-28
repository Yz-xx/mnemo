<script setup lang="ts">
import type { KnowledgePanelProps } from './useKnowledgePanel';
import { useKnowledgePanel } from './useKnowledgePanel';

const props = defineProps<KnowledgePanelProps>();

const { documents, title, content, busy, notice, addDocument, removeDocument } =
  useKnowledgePanel(props);
</script>

<template>
  <section class="knowledge__body">
    <label class="field">
      <span class="field__label">文档标题</span>
      <input v-model="title" class="field__input" placeholder="例如：产品说明书" />
    </label>
    <label class="field">
      <span class="field__label">文档内容</span>
      <textarea
        v-model="content"
        class="field__input field__input--area"
        rows="6"
        placeholder="粘贴需要入库的文本内容"
      />
    </label>
    <button class="btn btn--primary" :disabled="busy || !content.trim()" @click="addDocument">
      {{ busy ? '处理中…' : '加入知识库' }}
    </button>
    <p v-if="notice" class="knowledge__hint">{{ notice }}</p>

    <ul class="doc-list">
      <li v-for="item in documents" :key="item.id" class="doc">
        <div>
          <div class="doc__title">{{ item.title }}</div>
          <div class="doc__meta">{{ item.chunks }} 个片段</div>
        </div>
        <button class="icon-btn" title="删除文档" @click="removeDocument(item.id)">×</button>
      </li>
    </ul>
    <p v-if="documents.length === 0 && !notice" class="knowledge__hint">知识库为空</p>
  </section>
</template>

<style src="./KnowledgePanel.less" lang="less" scoped></style>
