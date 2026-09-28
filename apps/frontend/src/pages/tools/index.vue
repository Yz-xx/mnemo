<script setup lang="ts">
// LLM 工具：只读展示模型当前可用的工具，内容取自服务端运行时注入 Agent 的工具定义。
// 不是表格而是清单——工具数量少且每项文字长短悬殊，表格只会把描述挤成窄条。
import type { AdminToolItem } from '@/api/types';
import { onMounted, ref } from 'vue';
import { listAdminTools } from '@/api/admin';

const tools = ref<AdminToolItem[]>([]);
const loading = ref(false);
const errorMsg = ref('');

/** 序号补零：两位数编排让清单有版式节奏，也避免 1 与 10 左对齐时参差 */
function formatIndex(index: number): string {
  return String(index + 1).padStart(2, '0');
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    tools.value = await listAdminTools();
  } catch (e) {
    errorMsg.value = (e as Error).message || '加载工具清单失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="tools">
    <header class="tools__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="tools__lede">模型在对话中可以调用的能力，取自服务端运行时的工具定义</p>
      <p class="tools__stamp">共 {{ tools.length }} 项</p>
    </header>

    <p v-if="errorMsg" class="tools__error">{{ errorMsg }}</p>
    <p v-else-if="loading" class="tools__hint">加载中…</p>
    <p v-else-if="tools.length === 0" class="tools__hint">服务端未注册任何工具</p>

    <ul v-else class="tools__list">
      <li
        v-for="(tool, index) in tools"
        :key="tool.name"
        class="tools__item reveal"
        :style="{ '--reveal-index': index + 1 }"
      >
        <div class="tools__meta">
          <span class="tools__index">{{ formatIndex(index) }}</span>
          <h2 class="tools__name">{{ tool.name }}</h2>
        </div>
        <p class="tools__params">
          <span v-for="param in tool.params" :key="param" class="tools__param">{{ param }}</span>
          <span v-if="tool.params.length === 0" class="tools__param tools__param--empty">
            无需参数
          </span>
        </p>
        <p class="tools__desc">{{ tool.description }}</p>
      </li>
    </ul>
  </div>
</template>

<style scoped lang="less">
.tools {
  display: flex;
  flex-direction: column;
  gap: 16px;

  &__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
  }

  &__lede {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
  }

  &__stamp {
    margin: 0;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: var(--tracking-mono);
  }

  &__error {
    margin: 0;
    padding: 10px 14px;
    background-color: var(--danger-soft);
    border-left: 2px solid var(--danger);
    border-radius: var(--radius);
    color: var(--danger-strong);
    font-size: 13px;
  }

  &__hint {
    margin: 0;
    color: var(--text-faint);
    font-size: 13px;
  }

  // 两列错落的清单：工具名与参数并排，描述独占一行，读描述时不必横向追着看
  &__list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__item {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 18px;
    background-color: var(--bg);
    border: 1px solid var(--border);
    border-left: 2px solid var(--primary);
    border-radius: var(--radius);
    transition: border-color var(--transition);

    &:hover {
      border-color: var(--border-strong);
      border-left-color: var(--accent);
    }
  }

  &__meta {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  &__index {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
  }

  &__name {
    margin: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: var(--tracking-mono);
    overflow-wrap: anywhere;
  }

  &__params {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
  }

  // 参数名做成疏排小标：与工具名同为等宽族但更轻，一眼能分出「谁是能力、谁是输入」
  &__param {
    padding: 2px 7px;
    background-color: var(--bg-active);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);

    &--empty {
      background-color: transparent;
      color: var(--text-faint);
    }
  }

  &__desc {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.7;
    overflow-wrap: anywhere;
  }
}
</style>
