import type { ApiLogItem } from '@/api/types';
import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { formatTime } from '@mnemo/shared';

/** 详情字段：已展平成「标签 / 文本」，模板直接遍历渲染 */
export type LogsDetailField = { label: string; value: string };

export interface LogsDetailControls {
  detail: Ref<ApiLogItem | null>;
  detailFields: ComputedRef<LogsDetailField[]>;
  openDetail: (row: ApiLogItem) => void;
  closeDetail: () => void;
}

/**
 * 详情弹窗中的这一条日志与它展平后的字段：detail 为空表示未打开。
 * 值可能为空，统一用「—」占位，避免弹窗出现空白行。
 */
export function useLogsDetail(): LogsDetailControls {
  const detail = ref<ApiLogItem | null>(null);

  const detailFields = computed<LogsDetailField[]>(() => {
    const row = detail.value;
    if (!row) return [];
    return [
      { label: '请求 ID', value: row.requestId },
      { label: '请求', value: `${row.method} ${row.path}` },
      { label: '状态与耗时', value: `${row.status} · ${row.durationMs} ms` },
      { label: '用户', value: row.userId === null ? '未登录 / 超级令牌' : `#${row.userId}` },
      { label: '时间', value: formatTime(row.createdAt) },
      { label: '查询串', value: row.queryParams ?? '—' },
      { label: '请求体', value: row.requestBody ?? '—' },
      { label: '响应体', value: row.responseBody ?? '—' },
      { label: '错误', value: row.error ?? '—' },
    ];
  });

  function openDetail(row: ApiLogItem): void {
    detail.value = row;
  }

  function closeDetail(): void {
    detail.value = null;
  }

  return { detail, detailFields, openDetail, closeDetail };
}
