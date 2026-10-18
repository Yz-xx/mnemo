/** 知识库文档与检索结果实体 */

/** 文档可见范围：global 全局共享，private 仅上传者本人可见 */
export type KnowledgeScope = 'global' | 'private';

/** 文档元数据 */
export interface KnowledgeDocument {
  id: string;
  title: string;
  scope: KnowledgeScope;
  /** 私有文档的归属用户；全局文档为 null */
  ownerUserId: number | null;
  chunks: number;
  createdAt: string;
}

/** 写入目标：scope 决定归属，全局文档只能由管理入口写入 */
export interface KnowledgeUpload {
  title: string;
  content: string;
  scope: KnowledgeScope;
  userId: number;
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
  title: string;
  content: string;
  score: number;
}
