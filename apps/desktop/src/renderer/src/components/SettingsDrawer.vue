<script setup lang="ts">
import { ref, watch } from 'vue';
import { AgentApi } from '../api/client';
import type { HealthInfo } from '../api/client';
import type { KnowledgeDocument } from '../types';

const props = defineProps<{
  backendUrl: string;
  health: HealthInfo | null;
}>();

const emit = defineEmits<{
  close: [];
  save: [url: string];
}>();

const tab = ref<'connection' | 'knowledge'>('connection');
const urlDraft = ref(props.backendUrl);

const documents = ref<KnowledgeDocument[]>([]);
const title = ref('');
const content = ref('');
const busy = ref(false);
const notice = ref('');

// 知识库接口始终按当前填写的地址访问，便于保存前先验证连通性
const createApi = (): AgentApi => new AgentApi(urlDraft.value.trim() || props.backendUrl);

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

watch(tab, (value) => {
  if (value === 'knowledge') void loadDocuments();
});
</script>

<template>
  <div class="drawer">
    <div class="drawer__panel">
      <header class="drawer__head">
        <div class="tabs">
          <button
            class="tab"
            :class="{ 'tab--active': tab === 'connection' }"
            @click="tab = 'connection'"
          >
            连接
          </button>
          <button
            class="tab"
            :class="{ 'tab--active': tab === 'knowledge' }"
            @click="tab = 'knowledge'"
          >
            知识库
          </button>
        </div>
        <button class="icon-btn" title="关闭" @click="emit('close')">×</button>
      </header>

      <section v-if="tab === 'connection'" class="drawer__body">
        <label class="field">
          <span class="field__label">后端服务地址</span>
          <input v-model="urlDraft" class="field__input" placeholder="http://localhost:3000" />
        </label>
        <p class="drawer__hint">当前状态：{{ health ? `已连接（${health.model}）` : '未连接' }}</p>
        <button class="btn btn--primary" @click="emit('save', urlDraft)">保存并重连</button>
      </section>

      <section v-else class="drawer__body">
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
    </div>

    <div class="drawer__mask" @click="emit('close')" />
  </div>
</template>
