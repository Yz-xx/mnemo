<script setup lang="ts">
// 系统配置：只读展示服务端当前生效的运行参数，供运维核对。
// 密钥类配置（模型 API Key、MySQL 密码、知识库令牌）服务端只回「是否已配置」，页面拿不到明文。
import type { AdminSystemConfig } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import { fetchSystemConfig } from '@/api/admin';

/** 一行配置：state 用于给密钥类结果着色，普通参数留空 */
interface ConfigRow {
  label: string;
  value: string;
  state?: 'ok' | 'missing';
}

/** 一组配置：标题走英文疏排小标，与中文标签形成层级差 */
interface ConfigGroup {
  title: string;
  rows: ConfigRow[];
}

/** 字节容量转可读文本：上传上限按 MB 表述比一长串数字好核对 */
function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 密钥状态行：已配置 / 未配置，便于一眼看出哪项还没填 */
function secretRow(label: string, configured: boolean | undefined): ConfigRow[] {
  if (configured === undefined) return [];
  return [{ label, value: configured ? '已配置' : '未配置', state: configured ? 'ok' : 'missing' }];
}

const config = ref<AdminSystemConfig | null>(null);
const loading = ref(false);
const errorMsg = ref('');

const groups = computed<ConfigGroup[]>(() => {
  const item = config.value;
  if (!item) return [];
  return [
    {
      title: 'SERVICE',
      rows: [
        { label: '监听端口', value: String(item.port) },
        { label: '数据目录', value: item.dataDir },
      ],
    },
    {
      title: 'CHAT MODEL',
      rows: [
        { label: '提供方', value: item.llm.provider },
        { label: '模型', value: item.llm.model },
        { label: '服务地址', value: item.llm.endpoint },
        { label: '温度', value: String(item.llm.temperature) },
        ...secretRow('API Key', item.llm.apiKeyConfigured),
      ],
    },
    {
      title: 'EMBEDDING',
      rows: [
        { label: '提供方', value: item.embedding.provider },
        { label: '模型', value: item.embedding.model },
        { label: '服务地址', value: item.embedding.endpoint },
        ...secretRow('API Key', item.embedding.apiKeyConfigured),
      ],
    },
    {
      title: 'KNOWLEDGE',
      rows: [
        { label: '切片长度', value: String(item.knowledge.chunkSize) },
        { label: '切片重叠', value: String(item.knowledge.chunkOverlap) },
        { label: '检索条数', value: String(item.knowledge.topK) },
        { label: '相似度下限', value: String(item.knowledge.minScore) },
        ...secretRow('管理令牌', item.knowledge.adminTokenConfigured),
      ],
    },
    {
      title: 'UPLOAD',
      rows: [
        { label: '落盘目录', value: item.upload.dir },
        { label: '单文件上限', value: formatBytes(item.upload.maxBytes) },
        { label: '单次文件数', value: String(item.upload.maxFiles) },
        { label: '允许类型', value: item.upload.allowedTypes.join('、') },
      ],
    },
    {
      title: 'LOG',
      rows: [
        { label: '级别', value: item.log.level },
        { label: '目录', value: item.log.dir },
        { label: '保留天数', value: String(item.log.retentionDays) },
      ],
    },
    {
      title: 'MYSQL',
      rows: [
        { label: '地址', value: `${item.mysql.host}:${item.mysql.port}` },
        { label: '账号', value: item.mysql.user },
        { label: '数据库', value: item.mysql.database },
        ...secretRow('密码', item.mysql.passwordConfigured),
      ],
    },
  ];
});

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    config.value = await fetchSystemConfig();
  } catch (e) {
    errorMsg.value = (e as Error).message || '加载系统配置失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="config">
    <header class="config__head reveal" :style="{ '--reveal-index': 0 }">
      <p class="config__lede">
        服务端当前生效的运行参数，密钥类配置只显示是否已配置，改动需调整环境变量后重启
      </p>
    </header>

    <p v-if="errorMsg" class="config__error">{{ errorMsg }}</p>
    <p v-else-if="loading" class="config__hint">加载中…</p>

    <!-- 分组卡片按自适应列排布：参数多少不一，均分三列会让短组留下大片空白 -->
    <div v-else class="config__grid">
      <section
        v-for="(group, index) in groups"
        :key="group.title"
        class="config__group reveal"
        :style="{ '--reveal-index': index + 1 }"
      >
        <h2 class="config__title">{{ group.title }}</h2>
        <dl class="config__rows">
          <template v-for="row in group.rows" :key="row.label">
            <dt class="config__label">{{ row.label }}</dt>
            <dd class="config__value" :class="row.state && `config__value--${row.state}`">
              {{ row.value }}
            </dd>
          </template>
        </dl>
      </section>
    </div>
  </div>
</template>

<style scoped lang="less">
.config {
  display: flex;
  flex-direction: column;
  gap: 16px;

  &__lede {
    max-width: 720px;
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.7;
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

  // 默认 stretch 让同行卡片等高：align-items: start 会各卡自带高度，行底参差成锯齿；
  // 末行铺不满时用 auto-fill 保留空轨道（auto-fit 会拉伸末行卡片，反而列宽不一致）
  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
  }

  &__group {
    padding: 16px 18px;
    background-color: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  &__title {
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: var(--tracking-label);
  }

  &__rows {
    display: grid;
    grid-template-columns: 76px 1fr;
    gap: 8px 12px;
    margin: 0;
  }

  &__label {
    color: var(--text-faint);
    font-size: 12px;
    line-height: 1.7;
  }

  // 值一律走等宽族：路径、地址、参数名都是需要逐字核对的内容
  &__value {
    margin: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.7;
    overflow-wrap: anywhere;

    &--ok {
      color: var(--text-muted);
    }

    &--missing {
      color: var(--warning-strong);
    }
  }
}
</style>
