import type { Ref } from 'vue';
import { computed, ref } from 'vue';

export interface FilesSelectionControls {
  selectedKeys: Ref<Array<string | number>>;
  /** 批量接口要的文件 ID：行键本身就是字符串 ID */
  selectedIds: Ref<string[]>;
  clearSelection: () => void;
}

/**
 * 表格勾选：勾选键集合是本 hook 的本体，
 * 清空时机由调用方经 usePagedList 的 onReset 触发（选择随列表内容失效，不跨页保留）。
 */
export function useFilesSelection(): FilesSelectionControls {
  const selectedKeys = ref<Array<string | number>>([]);
  const selectedIds = computed(() => selectedKeys.value.map(String));

  function clearSelection(): void {
    selectedKeys.value = [];
  }

  return { selectedKeys, selectedIds, clearSelection };
}
