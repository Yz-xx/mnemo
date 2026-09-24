<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { AgentApi } from '../api/client';
import { useAuth } from '../composables/useAuth';
import type { KnowledgeDocument } from '../types';

const props = defineProps<{
  backendUrl: string;
}>();

// 知识库接口需要鉴权，复用同一份登录令牌
const { token } = useAuth();

const documents = ref<KnowledgeDocument[]>([]);
const title = ref('');
const content = ref('');
const busy = ref(false);
const notice = ref('');

// 始终按传入地址访问，便于在保存设置前先验证目标服务
const createApi = (): AgentApi => new AgentApi(props.backendUrl, token.value);

async function loadDocuments(): Promise<void> {
  try {
    documents.value = await createApi().listDocuments();
  } catch {
    documents.value = [];
  }
}

async function addDocument(): Promise<void> {
  if (!content.value.trim() || busy.value) return;
  busy.value = true;
  notice.value = '';
  try {
    await createApi().addDocument({ title: title.value, content: content.value });
    title.value = '';
    content.value = '';
    notice.value = '文档已入库，可被智能体检索';
    await loadDocuments();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function removeDocument(id: string): Promise<void> {
  try {
    await createApi().deleteDocument(id);
    await loadDocuments();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}

onMounted(() => void loadDocuments());
</script>

<template>
  <section class="drawer__body">
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
    <p v-if="notice" class="drawer__hint">{{ notice }}</p>

    <ul class="doc-list">
      <li v-for="item in documents" :key="item.id" class="doc">
        <div>
          <div class="doc__title">{{ item.title }}</div>
          <div class="doc__meta">{{ item.chunks }} 个片段</div>
        </div>
        <button class="icon-btn" title="删除文档" @click="removeDocument(item.id)">×</button>
      </li>
    </ul>
    <p v-if="documents.length === 0" class="drawer__hint">知识库为空</p>
  </section>
</template>
