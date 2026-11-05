/** 知识库文档与检索结果实体 */

/** 文档可见范围：global 全局共享，private 仅上传者本人可见 */
export type KnowledgeScope = 'global' | 'private';

/**
 * 知识库：文档的归属容器，可见性在库级表达——文档与片段不再各自持有可见性，
 * 权限、检索范围与会话绑定都以库为单元（见 docs/adr/0018）。
 */
export interface KnowledgeBase {
  id: string;
  name: string;
  /** 库描述：可选，未填写为 null */
  description: string | null;
  visibility: KnowledgeScope;
  /** private 库的归属用户；global 库无归属（仅管理令牌维护） */
  ownerUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 库列表读模型：实体之外附每库文档数，供列表页展示（计数不落库，随查询聚合） */
export interface KnowledgeBaseView extends KnowledgeBase {
  documentCount: number;
}

/** 文档解析状态：上传后进入 processing，解析成功转 ready，失败转 failed 可重试 */
export type DocumentStatus = 'processing' | 'ready' | 'failed';

/** 文档元数据：归属由所在知识库表达，可见性不再落在文档上（见 docs/adr/0018） */
export interface KnowledgeDocument {
  id: string;
  title: string;
  knowledgeBaseId: string;
  chunks: number;
  createdAt: string;
  /** 上传时的原始文件名：只入库展示，不参与落盘路径；粘贴文本入库为 null */
  fileName: string | null;
  /** 原始文件字节数：粘贴文本入库为 null */
  fileSize: number | null;
  /** 由 magic bytes 判定出的 MIME：粘贴文本入库为 null */
  mimeType: string | null;
  status: DocumentStatus;
  /** 解析失败的中文原因：仅 failed 态有值 */
  failureReason: string | null;
}

/** 写入目标：入库前由服务层校验目标库的归属与可见性 */
export interface KnowledgeUpload {
  title: string;
  content: string;
  knowledgeBaseId: string;
}

/**
 * 文件上传的待解析记录：documentId 先由上传入口生成，文件按该 id 落盘，
 * 解析任务据此定位文件；原始文件名只入库展示，不参与路径。
 */
export interface KnowledgeFileUpload {
  id: string;
  title: string;
  knowledgeBaseId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

/** 操作者身份：管理员可删任意文档（含他人私有），普通用户仅限自己上传的私有文档 */
export interface KnowledgeActor {
  userId: number;
  isAdmin: boolean;
}

/**
 * 文档内容读取结果。source 标记内容来源：
 * raw 为库内存档的原文；stitched 为旧文档无原文、按分片顺序拼接的近似还原
 * （分片带重叠且段落已被切开，只能看个大概，保存一次编辑即留存正式原文）。
 */
export interface KnowledgeContent {
  document: KnowledgeDocument;
  content: string;
  source: 'raw' | 'stitched';
  /** 最后编辑时间；从未编辑过为 null */
  updatedAt: string | null;
}

/** 检索命中：同一文档可能命中多个片段，去重与来源标签都以 documentId 为准 */
export interface KnowledgeSearchResult {
  /** 所属文档 ID */
  documentId: string;
  /** 片段 ID：引用协议据此定位预览与高亮 */
  chunkId: string;
  title: string;
  content: string;
  /** 片段所在原始文件页码；文本来源或旧数据无定位信息时为 null */
  page: number | null;
  score: number;
}
