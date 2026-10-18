/** 附件实体：上传中间态、已入库元数据与管理端视图 */

/** 待入库的上传内容：类型已由 magic bytes 判定，name 仅作展示 */
export interface UploadedFile {
  name: string;
  ext: string;
  mime: string;
  bytes: Buffer;
}

/** 已落到临时文件的上传内容：字节不进内存，入库时以改名搬到正式路径（见 docs/adr/0010 决策 14） */
export interface StreamedUpload {
  name: string;
  ext: string;
  mime: string;
  /** 字节数：由 multer 边写边统计，无需再读一遍文件 */
  size: number;
  /** multer 写入的临时文件路径：入库成功后改名到最终路径 */
  tempPath: string;
}

/** 已入库的文件元数据：客户端与工具层都只看这份信息 */
export interface StoredFile {
  id: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  createdAt: string;
}

/** 取出的原始字节所在位置：路径由元数据推导，因此两者必须成对返回，不能只给其一 */
export interface LoadedFile {
  file: StoredFile;
  bytes: Buffer;
}

/** 管理端文件记录：在文件元数据之上补上传者 ID，前端据此显示归属 */
export interface AdminFileRecord extends StoredFile {
  userId: number;
}

/** 管理端列表查询条件：keyword 按文件名包含匹配，分页已在路由层收敛 */
export interface AdminFileQuery {
  keyword: string;
  page: number;
  pageSize: number;
}

/** 管理端分页结果：total 为满足条件的总数 */
export interface AdminFilePage {
  items: AdminFileRecord[];
  total: number;
}
