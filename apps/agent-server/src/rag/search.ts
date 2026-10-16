export interface KnowledgeSearchResult {
  /** 所属文档 ID：同一文档可能命中多个片段，去重与来源标签都以它为准 */
  documentId: string;
  title: string;
  content: string;
  score: number;
}
