import type { Ref } from 'vue';
import { ref } from 'vue';

interface AuditFilterDeps {
  /** 回到第一页再取数：取数动作由入口经 usePagedList 建好后注入，本 hook 不反向依赖入口 */
  search: () => Promise<void>;
}

export interface AuditFilterControls {
  keyword: Ref<string>;
  handleSearch: () => Promise<void>;
}

/**
 * 审计页的筛选条件：只持有搜索关键词，触发取数沿用分页列表的 search（先回第一页再筛）。
 * 关键词是取数的输入，故本 hook 建在最前，由入口把它接进 usePagedList 的 fetcher。
 */
export function useAuditFilter({ search }: AuditFilterDeps): AuditFilterControls {
  const keyword = ref('');

  return { keyword, handleSearch: search };
}
