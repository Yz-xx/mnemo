/** 分页响应：items 为当前页数据，total 为满足条件的总数 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
