<script setup lang="ts">
import type { KnowledgePanelProps } from './useKnowledgePanel';
import { useKnowledgePanel } from './useKnowledgePanel';

const props = defineProps<KnowledgePanelProps>();

const { baseState, form, upload, list, STATUS_TEXT } = useKnowledgePanel(props);
</script>

<template>
  <section class="knowledge__body">
    <!-- 库详情：文档上传与列表；返回库列表由左上角入口提供 -->
    <template v-if="baseState.activeBase">
      <div class="kb-detail__head">
        <button class="text-btn" type="button" @click="baseState.back">← 返回库列表</button>
        <span class="kb-detail__title">{{ baseState.activeBase.name }}</span>
        <span class="chip">{{
          baseState.activeBase.visibility === 'global' ? '共享' : '私有'
        }}</span>
      </div>
      <p v-if="baseState.activeBase.description" class="knowledge__hint">
        {{ baseState.activeBase.description }}
      </p>

      <!-- 共享库只读：文档由管理端维护，客户端只提供查看，不展示写入入口 -->
      <template v-if="baseState.activeBase.visibility === 'private'">
        <!-- 拖拽区：投放即上传；也可点选文件后按下面的按钮提交 -->
        <div
          class="kb-drop"
          :class="{ 'kb-drop--busy': upload.uploading }"
          @dragover.prevent
          @drop.prevent="upload.dropFile"
        >
          <p class="kb-drop__title">拖拽文件到这里，或点选文件</p>
          <label class="kb-drop__pick">
            <span class="btn btn--primary">选择文件</span>
            <input
              class="kb-drop__input"
              type="file"
              accept=".txt,.md,.pdf,.docx,.xlsx"
              @change="upload.selectFile"
            />
          </label>
          <p class="kb-drop__hint">支持 txt / md / pdf / docx / xlsx，上传后自动解析</p>
        </div>

        <div class="knowledge__actions">
          <span v-if="upload.file" class="chip">{{ upload.file.name }}</span>
          <button class="btn" :disabled="!upload.file || upload.uploading" @click="upload.upload">
            {{ upload.uploading ? `上传中 ${upload.progress}%` : '上传并解析' }}
          </button>
          <button v-if="upload.uploading" class="btn" @click="upload.cancel">取消上传</button>
        </div>

        <label class="field">
          <span class="field__label">文档标题</span>
          <input v-model="form.title" class="field__input" placeholder="例如：产品说明书" />
        </label>
        <label class="field">
          <span class="field__label">文档内容</span>
          <textarea
            v-model="form.content"
            class="field__input field__input--area"
            rows="5"
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
      </template>
      <p v-else class="knowledge__hint">共享知识库由管理员维护，这里只读查看。</p>

      <p v-if="list.notice" class="knowledge__hint">{{ list.notice }}</p>

      <ul class="doc-list">
        <li v-for="item in list.documents" :key="item.id" class="doc">
          <div class="doc__info">
            <div class="doc__title">{{ item.title }}</div>
            <div class="doc__meta">
              <span class="doc__status" :class="`doc__status--${item.status}`">
                {{ STATUS_TEXT[item.status] }}
              </span>
              <span v-if="item.status === 'ready'">{{ item.chunks }} 个片段</span>
            </div>
            <div v-if="item.fileName" class="doc__meta">源文件：{{ item.fileName }}</div>
            <div v-if="item.status === 'failed'" class="doc__reason">
              {{ item.failureReason || '解析失败，可重试' }}
            </div>
          </div>
          <!-- 共享库文档同样只读：重试与删除由管理端承担 -->
          <div v-if="baseState.activeBase.visibility === 'private'" class="doc__tools">
            <button
              v-if="item.status === 'failed'"
              class="text-btn"
              @click="list.retryDocument(item.id)"
            >
              重试
            </button>
            <button class="icon-btn" title="删除文档" @click="list.removeDocument(item.id)">
              ×
            </button>
          </div>
        </li>
      </ul>
      <p v-if="list.isEmpty && !list.notice" class="knowledge__hint">这个库还没有文档</p>
    </template>

    <!-- 库列表：卡片展示名称、描述与文档数；私有库可编辑、删除 -->
    <template v-else>
      <div class="kb-list__head">
        <span class="kb-list__title">知识库</span>
        <button class="btn btn--primary" @click="baseState.openCreate">新建知识库</button>
      </div>
      <p v-if="baseState.bases.length === 0" class="knowledge__hint">
        还没有知识库。新建一个，上传文档后即可在对话中选择它检索。
      </p>
      <ul class="kb-list">
        <li
          v-for="base in baseState.bases"
          :key="base.id"
          class="kb-card"
          @click="baseState.enter(base)"
        >
          <div class="kb-card__head">
            <span class="kb-card__name">{{ base.name }}</span>
            <span class="chip">{{ base.visibility === 'global' ? '共享' : '私有' }}</span>
          </div>
          <p class="kb-card__desc">{{ base.description || '暂无描述' }}</p>
          <div class="kb-card__foot">
            <span class="kb-card__count">{{ base.documentCount }} 篇文档</span>
            <div v-if="base.visibility === 'private'" class="kb-card__tools">
              <button class="text-btn" @click.stop="baseState.openEdit(base)">编辑</button>
              <button class="text-btn text-btn--danger" @click.stop="baseState.requestDelete(base)">
                删除
              </button>
            </div>
          </div>
        </li>
      </ul>
      <p v-if="list.notice" class="knowledge__hint">{{ list.notice }}</p>
    </template>

    <!-- 新建 / 编辑对话框 -->
    <div v-if="baseState.editor.visible" class="modal">
      <div class="modal__panel">
        <h3 class="modal__title">
          {{ baseState.editor.mode === 'create' ? '新建知识库' : '编辑知识库' }}
        </h3>
        <label class="field">
          <span class="field__label">名称</span>
          <input
            v-model="baseState.editor.name"
            class="field__input"
            maxlength="128"
            placeholder="例如：产品手册"
          />
        </label>
        <label class="field">
          <span class="field__label">描述</span>
          <textarea
            v-model="baseState.editor.description"
            class="field__input field__input--area"
            rows="3"
            placeholder="这个库存放什么，便于区分"
          />
        </label>
        <p v-if="baseState.editor.error" class="modal__error">{{ baseState.editor.error }}</p>
        <div class="modal__actions">
          <button class="btn" @click="baseState.closeEditor">取消</button>
          <button
            class="btn btn--primary"
            :disabled="baseState.editor.busy"
            @click="baseState.submitEditor"
          >
            {{ baseState.editor.busy ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
      <div class="modal__mask" @click="baseState.closeEditor" />
    </div>

    <!-- 删除二次确认：明确告知级联范围，避免误删整库文档 -->
    <div v-if="baseState.deleteTarget" class="modal">
      <div class="modal__panel">
        <h3 class="modal__title">删除知识库</h3>
        <p class="modal__text">
          将删除「{{ baseState.deleteTarget?.name }}」及其
          {{ baseState.deleteTarget?.documentCount }} 篇文档和全部片段，且不可恢复。
        </p>
        <div class="modal__actions">
          <button class="btn" @click="baseState.cancelDelete">取消</button>
          <button class="btn btn--danger" @click="baseState.confirmDelete">确认删除</button>
        </div>
      </div>
      <div class="modal__mask" @click="baseState.cancelDelete" />
    </div>
  </section>
</template>

<style src="./KnowledgePanel.less" lang="less" scoped></style>
