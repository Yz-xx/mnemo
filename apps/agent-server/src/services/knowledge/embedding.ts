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

/** 切分出的片段：页码来自 PDF 解析输出的页标记，文本来源没有标记时为 null */
export interface ChunkPiece {
  content: string;
  page: number | null;
}

/** PDF 解析输出的页标记：形如「【第 3 页】」，见 infrastructure/files/parser.ts。带 g 才能逐条扫出片段内的全部标记 */
const PAGE_MARKER = /【第\s*(\d+)\s*页】/g;

/** 一段待切分正文及其页码：无页标记的文本整篇视为一段，page 为 null */
interface PageBlock {
  page: number | null;
  text: string;
}

/**
 * 按页标记把原文拆成段，标记本身不进入正文。
 * 不能把带标记的整篇直接交给切分器：标记形如「【第 1 页】」含空格，
 * RecursiveCharacterTextSplitter 会先按空格切，标记被切成「【第」「1」「页】」三段，
 * 片段里再也匹配不到完整标记，页码随之丢失。
 * 每段页码由前一条标记决定，第一条标记之前的正文没有归属，保持 null。
 */
function splitByPages(content: string): PageBlock[] {
  const blocks: PageBlock[] = [];
  let cursor = 0;
  let page: number | null = null;
  for (const marker of content.matchAll(PAGE_MARKER)) {
    const index = marker.index ?? 0;
    const text = content.slice(cursor, index);
    if (text.trim() !== '') blocks.push({ page, text });
    cursor = index + marker[0].length;
    page = Number(marker[1]);
  }
  const tail = content.slice(cursor);
  if (tail.trim() !== '') blocks.push({ page, text: tail });
  return blocks;
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
): Promise<{ pieces: ChunkPiece[]; vectors: number[][]; dim: number }> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: ctx.options.chunkSize,
    chunkOverlap: ctx.options.chunkOverlap,
  });

  // 逐页切分：页边界天然不会被片段跨越，同页切出的多段全部继承该页页码
  const pieces: ChunkPiece[] = [];
  for (const block of splitByPages(content)) {
    const chunks = await splitter.splitText(block.text);
    pieces.push(...chunks.map((text) => ({ content: text, page: block.page })));
  }
  if (pieces.length === 0) throw new Error('文档内容为空，无法切分');

  const vectors = await callEmbedding(ctx.governance, () =>
    embedDocuments(
      ctx,
      pieces.map((piece) => piece.content),
    ),
  );
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) throw new Error('文档向量化结果为空');
  await ctx.store.assertCompatible(dim);
  return { pieces, vectors, dim };
}
