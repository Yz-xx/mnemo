import type { UserStatus } from '@/api/types';
import type { Ref } from 'vue';
import { computed, ref } from 'vue';
import { batchUpdateUserStatus } from '@/api';

interface UsersSelectionDeps {
  /** 行内变更的统一出口：批量操作复用它，锁与错误回显口径与行内保持一致 */
  mutate: (action: () => Promise<unknown>, fallback: string) => Promise<void>;
}

export interface UsersSelectionControls {
  selectedKeys: Ref<Array<string | number>>;
  selectedIds: Ref<number[]>;
  clearSelection: () => void;
  batchStatus: (status: UserStatus) => void;
}

/**
 * 表格勾选与批量启停：勾选键集合是本 hook 的本体，
 * 清空时机由调用方经 usePagedList 的 onReset 触发（选择随列表内容失效，不跨页保留）。
 */
export function useUsersSelection({ mutate }: UsersSelectionDeps): UsersSelectionControls {
  const selectedKeys = ref<Array<string | number>>([]);
  /** 批量接口要的账号 ID：行键本就是 id，这里统一收窄为 number */
  const selectedIds = computed(() => selectedKeys.value.map(Number));

  function clearSelection(): void {
    selectedKeys.value = [];
  }

  /** 批量停用 / 启用：可逆操作不弹确认，整批规则由服务端判定 */
  function batchStatus(status: UserStatus): void {
    void mutate(() => batchUpdateUserStatus(selectedIds.value, status), '批量变更状态失败');
  }

  return { selectedKeys, selectedIds, clearSelection, batchStatus };
}
