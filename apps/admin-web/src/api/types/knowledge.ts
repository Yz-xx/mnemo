/** 文档可见范围：global 全局共享，private 仅上传者本人可见 */
export type KnowledgeScope = 'global' | 'private';

/** 管理端知识库文档：归属由所在库表达，另附库归属账号名（共享库为 null） */
export interface AdminKnowledgeDocument {
  id: string;
  title: string;
  knowledgeBaseId: string;
  ownerName: string | null;
  chunks: number;
  createdAt: string;
}

/** 管理端知识库：库字段 + 每库文档数 + 归属账号名（共享库无归属） */
export interface AdminKnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  visibility: KnowledgeScope;
  ownerUserId: number | null;
  ownerName: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 管理端文档内容读取结果。source 标记内容来源：
 * raw 为库内存档原文；stitched 为旧文档无原文、按分片拼接的近似还原，
 * 保存一次编辑即留存正式原文
 */
export interface AdminKnowledgeContent {
  document: AdminKnowledgeDocument;
  content: string;
  source: 'raw' | 'stitched';
  updatedAt: string | null;
}
