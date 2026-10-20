import type { AdminSystemConfig } from '@/api/types';
import { computed, onMounted, ref } from 'vue';
import { formatBytes } from '@mnemo/shared';
import { fetchSystemConfig } from '@/api';

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

/** 密钥状态行：已配置 / 未配置，便于一眼看出哪项还没填 */
function secretRow(label: string, configured: boolean | undefined): ConfigRow[] {
  if (configured === undefined) return [];
  return [{ label, value: configured ? '已配置' : '未配置', state: configured ? 'ok' : 'missing' }];
}

/**
 * 系统配置页的取数与分组：把服务端返回的扁平配置铺成若干展示分组，
 * 密钥类字段服务端只回「是否已配置」，这里按 state 区分着色。
 */
export function useConfigPage() {
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
        title: 'POSTGRES',
        rows: [
          { label: '地址', value: `${item.postgres.host}:${item.postgres.port}` },
          { label: '账号', value: item.postgres.user },
          { label: '数据库', value: item.postgres.database },
          ...secretRow('密码', item.postgres.passwordConfigured),
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

  return { errorMsg, loading, groups };
}
