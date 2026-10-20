import type { AuditLogItem } from '@/api/types';
import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { formatTime } from '@mnemo/shared';

interface AuditDetailDeps {
  /** 操作人展示口径与列表行共用，由入口注入，避免详情与列表各写一份映射 */
  actorLabel: (row: AuditLogItem) => string;
}

/** 详情里的一行：入口返回的分组要带出这个形状，故须导出 */
export interface AuditDetailField {
  label: string;
  value: string;
}

export interface AuditDetailControls {
  detail: Ref<AuditLogItem | null>;
  detailFields: ComputedRef<AuditDetailField[]>;
}

/**
 * 审计详情弹窗：只持有当前查看的这一条，字段列表由它派生。
 * 值可能为空，统一用「—」占位，避免弹窗出现空白行。
 */
export function useAuditDetail({ actorLabel }: AuditDetailDeps): AuditDetailControls {
  /** 详情弹窗中的这一条：为空表示未打开 */
  const detail = ref<AuditLogItem | null>(null);

  const detailFields = computed<AuditDetailField[]>(() => {
    const row = detail.value;
    if (!row) return [];
    return [
      { label: '操作人', value: actorLabel(row) },
      { label: '操作', value: `${row.method} ${row.path}` },
      { label: '结果', value: String(row.status) },
      { label: '时间', value: formatTime(row.createdAt) },
      { label: '请求体', value: row.detail ?? '—' },
    ];
  });

  return { detail, detailFields };
}
