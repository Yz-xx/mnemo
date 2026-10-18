import type { AdminFileQuery, AdminFileRecord } from '../../entities/file.js';
import type { FileStore } from '../../mappers/file/fileStore.js';
import type { UserStore } from '../../mappers/user/store.js';

/** 管理端文件视图：不按上传者过滤，归属账号名在这里一次批量补上 */

export interface AdminFileDeps {
  files: Pick<FileStore, 'listAll'>;
  users: Pick<UserStore, 'findNamesByIds'>;
}

/** 列表项：文件元数据 + 归属账号名；账号已删时为 null */
export interface AdminFileListItem extends AdminFileRecord {
  ownerName: string | null;
}

/** 列表响应：分页字段原样回传给前端计算总页数 */
export interface AdminFileListResponse {
  items: AdminFileListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 管理端文件列表：按文件名包含匹配 + 分页 */
export async function listAdminFiles(
  deps: AdminFileDeps,
  query: AdminFileQuery,
): Promise<AdminFileListResponse> {
  const { items, total } = await deps.files.listAll(query);
  const names = await deps.users.findNamesByIds(items.map((item) => item.userId));
  return {
    items: items.map((item) => ({ ...item, ownerName: names.get(item.userId) ?? null })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}
