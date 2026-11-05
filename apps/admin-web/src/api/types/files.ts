/** 管理端文件：在文件元数据之上带上传者与归属账号名 */
export interface AdminFileItem {
  id: string;
  userId: number;
  ownerName: string | null;
  name: string;
  ext: string;
  mime: string;
  size: number;
  createdAt: string;
}
