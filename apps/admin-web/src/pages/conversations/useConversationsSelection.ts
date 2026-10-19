import type { Ref } from 'vue';
import { computed, ref } from 'vue';

export interface ConversationsSelectionControls {
  selectedKeys: Ref<Array<string | number>>;
  selectedIds: Ref<string[]>;
  clearSelection: () => void;
}

/**
 * 表格勾选：勾选键集合是本 hook 的本体，
 * 清空时机由调用方经 usePagedList 的 onReset 触发（选择随列表内容失效，不跨页保留）。
 */
export function useConversationsSelection(): ConversationsSelectionControls {
  /** 已勾选行的键：翻页、搜索或重新取数后由 load 清空，不做跨页保留 */
  const selectedKeys = ref<Array<string | number>>([]);
  /** 批量接口要的会话 ID：行键本身就是字符串 ID */
  const selectedIds = computed(() => selectedKeys.value.map(String));

  function clearSelection(): void {
    selectedKeys.value = [];
  }

  return { selectedKeys, selectedIds, clearSelection };
}
