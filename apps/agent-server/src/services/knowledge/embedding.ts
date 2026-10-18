import type { RetrievalGovernance } from './retrieval.js';
import type {
  KnowledgeStoreOptions,
  KnowledgeVectorStore,
} from '../../mappers/knowledge/vectorStore.js';
import type { Embeddings } from '@langchain/core/embeddings';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { describeConnectionError } from '../../common/errors.js';
import { callEmbedding } from './retrieval.js';

/**
 * 切分与向量化的上下文：写入路径所需的三个只读依赖收成一份，
 * 免得逐参数透传（store 实例在构造后即固定，取值口径不变）。
 */
export interface EmbeddingContext {
  embeddings: Embeddings;
  store: KnowledgeVectorStore;
  options: KnowledgeStoreOptions;
  /** 检索与向量化治理：不传即不治理（本地脚本与单测），生产由组合根注入 */
  governance?: RetrievalGovernance;
}

/**
 * 批量向量化片段：写入路径（入库与编辑）用。
 * 连接类异常翻译成含服务地址的提示，与检索路径同一口径
 */
async function embedDocuments(ctx: EmbeddingContext, texts: string[]): Promise<number[][]> {
  try {
    return await ctx.embeddings.embedDocuments(texts);
  } catch (error) {
    throw describeConnectionError(error, ctx.options.embeddingEndpoint, '向量化服务');
  }
}

/**
 * 切分并批量向量化：空内容与空结果直接抛错，基准校验失败原样抛出。
 * 入库与编辑共用，且始终在动库之前完成——最易失败的步骤前置，
 * 失败时库内数据保持原样，重试即可恢复。
 * 这是写入路径：向量服务失败或熔断打开都直接抛出，不做降级（见 docs/adr/0010 决策 11）
 */
export async function splitAndEmbed(
  ctx: EmbeddingContext,
  content: string,
): Promise<{ pieces: string[]; vectors: number[][]; dim: number }> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: ctx.options.chunkSize,
    chunkOverlap: ctx.options.chunkOverlap,
  });
  const pieces = await splitter.splitText(content);
  if (pieces.length === 0) throw new Error('文档内容为空，无法切分');

  const vectors = await callEmbedding(ctx.governance, () => embedDocuments(ctx, pieces));
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) throw new Error('文档向量化结果为空');
  await ctx.store.assertCompatible(dim);
  return { pieces, vectors, dim };
}
