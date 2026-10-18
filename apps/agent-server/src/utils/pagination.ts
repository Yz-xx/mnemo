/** 后台列表统一分页口径：默认条数与上限各列表保持一致，翻页交互才能一致 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** 正整数参数：非法或缺失时回退默认值，翻页参数不值得单独回 400 */
export function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 收敛翻页参数：后台各列表都要做「page 取正整数、pageSize 取正整数并封顶」同一套处理，
 * 收在这里后调用处只写一行，也避免某处漏掉上限而把整张表拉回浏览器。
 */
export function parsePaging(query: { page?: unknown; pageSize?: unknown }): {
  page: number;
  pageSize: number;
} {
  return {
    page: toPositiveInt(query.page, 1),
    pageSize: Math.min(toPositiveInt(query.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE),
  };
}
