import type { ApiLogQuery, ApiLogRecord } from '../../entities/apiLog.js';
import type { ApiLogStore } from '../../mappers/apiLog/store.js';

/** 接口日志检索：只读，写入由请求日志中间件在响应结束时完成 */

/** 列表响应：分页字段由本层回填，存储层只负责 items 与 total */
export interface ApiLogListResponse {
  items: ApiLogRecord[];
  total: number;
  page: number;
  pageSize: number;
}

/** 日志列表：路径关键词 + 方法 + 状态档位过滤，按时间倒序分页 */
export async function listApiLogs(
  store: Pick<ApiLogStore, 'list'>,
  query: ApiLogQuery,
): Promise<ApiLogListResponse> {
  const { items, total } = await store.list(query);
  return { items, total, page: query.page, pageSize: query.pageSize };
}
