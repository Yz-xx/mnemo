import type { Ref } from 'vue';
import { computed, ref } from 'vue';

/** 表格勾选对页面暴露的接口：勾选键交给 DataTable，ID 列表交给批量接口 */
export interface TableSelection<T> {
  selectedKeys: Ref<Array<string | number>>;
  selectedIds: Ref<T[]>;
  clearSelection: () => void;
}

/**
 * 表格勾选的通用实现：勾选键集合是本体，
 * 清空时机由调用方经 usePagedList 的 onReset 触发（选择随列表内容失效，不跨页保留）。
 * 行键到接口 ID 的换算由调用方注入：文件 / 文档 / 会话本就是字符串 ID，账号是数字 ID。
 */
function useSelection<T>(toId: (key: string | number) => T): TableSelection<T> {
  const selectedKeys = ref<Array<string | number>>([]);
  const selectedIds = computed<T[]>(() => selectedKeys.value.map(toId));

  function clearSelection(): void {
    selectedKeys.value = [];
  }

  return { selectedKeys, selectedIds, clearSelection };
}

/** 字符串 ID 列表（文件、知识文档、会话）：行键即接口 ID */
export function useStringTableSelection(): TableSelection<string> {
  return useSelection((key) => String(key));
}

/** 数字 ID 列表（账号）：行键即接口 ID，批量接口要 number */
export function useNumberTableSelection(): TableSelection<number> {
  return useSelection((key) => Number(key));
}
