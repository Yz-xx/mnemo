import type { Logger } from '@repo/logger';
import type { KnowledgeDocument, KnowledgeStore, KnowledgeUpload } from '../rag/store.js';

/**
 * 文档入库编排：切分与向量化都在 KnowledgeStore 内完成，这里只负责计时与日志。
 * 归属范围由调用方（路由）按入口决定：客户端只能写私有，全局走管理令牌校验的接口。
 * 失败时保留原始错误落日志后再抛出，状态码与对外文案由路由决定
 * （入库失败集中在向量化服务未启动与向量基准不符两类，必须留下原始错误才好定位）。
 */
export async function addDocument(
  knowledge: KnowledgeStore,
  logger: Logger,
  input: KnowledgeUpload,
): Promise<KnowledgeDocument> {
  const startedAt = Date.now();
  try {
    const document = await knowledge.add(input);
    logger.info('文档入库完成', {
      documentId: document.id,
      title: document.title,
      scope: document.scope,
      chunkCount: document.chunks,
      durationMs: Date.now() - startedAt,
      userId: input.userId,
    });
    return document;
  } catch (error) {
    logger.error('文档入库失败', {
      title: input.title,
      scope: input.scope,
      userId: input.userId,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}
