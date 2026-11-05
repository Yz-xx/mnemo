import type { KnowledgeStore } from './store.js';
import type { KnowledgeActor, KnowledgeDocument } from '../../entities/knowledge.js';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isTextExtension } from './fileInput.js';
import { knowledgeFilePath } from './ingest.js';

/** 预览依赖：库存储用于取解析后全文，上传目录用于定位原始文件 */
export interface PreviewContext {
  knowledge: Pick<KnowledgeStore, 'getContent'>;
  /** 上传根目录（config.upload.dir） */
  uploadDir: string;
}

/** 预览结果：文本类直出全文，二进制类给出流式起点，missing 表示原文已不可用 */
export type DocumentPreview =
  | { kind: 'text'; content: string; document: KnowledgeDocument }
  | { kind: 'file'; filePath: string; fileName: string; mimeType: string }
  | { kind: 'missing' };

/** 扩展名判定：粘贴文本没有原始文件名，此时 ext 为空串 */
function extOf(document: KnowledgeDocument): string {
  return path
    .extname(document.fileName ?? '')
    .slice(1)
    .toLowerCase();
}

/**
 * 解析文档预览。
 * 文本类取已解析全文（粘贴文本与旧文档的拼接结果同样可用）；二进制类不读内容，
 * 只确认原始文件存在后交给路由流式输出——PDF 常有几十兆，整读进内存会拖垮并发。
 * 调用方须先校验文档可见性，这里不再重复鉴权。
 */
export async function readDocumentPreview(
  context: PreviewContext,
  document: KnowledgeDocument,
  actor: KnowledgeActor,
): Promise<DocumentPreview> {
  // 粘贴文本（无原始文件名）也按文本类处理：内容只存在于库内原文
  if (document.fileName === null || isTextExtension(extOf(document))) {
    const stored = await context.knowledge.getContent(document.id, actor);
    return stored ? { kind: 'text', content: stored.content, document } : { kind: 'missing' };
  }

  const filePath = knowledgeFilePath(context.uploadDir, document.id);
  try {
    // 先确认可读再写响应头：否则 404 只能落在已建好的流上，客户端拿到半截响应
    await fs.access(filePath, constants.R_OK);
  } catch {
    return { kind: 'missing' };
  }
  return {
    kind: 'file',
    filePath,
    fileName: document.fileName,
    mimeType: document.mimeType ?? 'application/octet-stream',
  };
}
