import type { KnowledgeIngest } from './ingest.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeActor, KnowledgeDocument } from '../../entities/knowledge.js';
import type { Logger } from '@mnemo/logger';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectKnowledgeFile, type UploadedFileLike } from './fileInput.js';
import { describeIngestFailure, knowledgeFilePath } from './ingest.js';

/** 文件标题上限：默认取原始文件名，超长截断，避免撑开列表 */
const FILE_TITLE_MAX_LENGTH = 180;

/** 文件上传与重试共同依赖：存储与解析任务 */
export interface KnowledgeFileContext {
  knowledge: KnowledgeStore;
  ingest: KnowledgeIngest;
  /** 上传根目录（config.upload.dir） */
  uploadDir: string;
}

/** 上传结果：路由只按 kind 翻状态码，不承担落盘与入队细节 */
export type AcceptUploadResult =
  | { kind: 'created'; document: KnowledgeDocument }
  | { kind: 'invalid'; message: string }
  | { kind: 'failed'; message: string };

/**
 * 接收一个上传文件：校验 → 建 processing 记录 → 搬入知识库目录 → 入队解析。
 * 临时文件无论成败都在退出前清理（成功时已被 rename 搬走，rm 是空操作）。
 * 记录已建但后续步骤失败时标 failed 并保留中文原因，用户可在列表里看到并重试。
 */
export async function acceptKnowledgeUpload(
  context: KnowledgeFileContext,
  logger: Logger,
  baseId: string,
  file: UploadedFileLike,
): Promise<AcceptUploadResult> {
  let document: KnowledgeDocument | null = null;
  try {
    const inspected = await inspectKnowledgeFile(file);
    if (!inspected.ok) {
      // 先清理再响应：客户端收到 400 时临时文件必须已经不在，不能等 finally 之后
      await fs.rm(file.path, { force: true });
      return { kind: 'invalid', message: inspected.message };
    }

    // 原始文件名只入库展示，不参与落盘路径；标题直接取它并按列上限截断
    const title = inspected.value.fileName.slice(0, FILE_TITLE_MAX_LENGTH);
    document = await context.knowledge.addPending({
      id: randomUUID(),
      title,
      knowledgeBaseId: baseId,
      fileName: inspected.value.fileName,
      fileSize: inspected.value.fileSize,
      mimeType: inspected.value.mime,
    });

    // 正式文件按文档 ID 命名；目录首次上传时补建
    const target = knowledgeFilePath(context.uploadDir, document.id);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(file.path, target);

    context.ingest.enqueue(document);
    return { kind: 'created', document };
  } catch (error) {
    if (document) {
      await context.knowledge
        .markFailed(document.id, describeIngestFailure(error))
        .catch(() => undefined);
    }
    // 失败路径必须带原始 error：搬文件失败时只有对外文案会丢掉可排查的底层原因
    logger.error('知识库文件上传失败', {
      knowledgeBaseId: baseId,
      documentId: document?.id,
      error,
    });
    return { kind: 'failed', message: '文件上传失败，请稍后重试' };
  } finally {
    await fs.rm(file.path, { force: true });
  }
}

/** 重试结果：failed 之外一律按不可重试处理 */
export type RetryDocumentResult =
  | { kind: 'retried'; document: KnowledgeDocument }
  | { kind: 'notFound' }
  | { kind: 'notRetryable' };

/**
 * 重试解析：仅 failed 文档可重试，重置 processing 后重新入队。
 * 旧片段由解析回写步骤在成功事务内整体重建，这里不预先删除。
 */
export async function retryKnowledgeDocument(
  knowledge: KnowledgeStore,
  ingest: KnowledgeIngest,
  id: string,
  actor: KnowledgeActor,
): Promise<RetryDocumentResult> {
  const document = await knowledge.findManageable(id, actor);
  if (!document) return { kind: 'notFound' };
  if (document.status !== 'failed') return { kind: 'notRetryable' };

  // 重置与入队之间文档可能已被删：命中 0 行按不存在处理，不复活已删文档
  if (!(await knowledge.markProcessing(document.id))) return { kind: 'notFound' };
  const pending: KnowledgeDocument = { ...document, status: 'processing', failureReason: null };
  ingest.enqueue(pending);
  return { kind: 'retried', document: pending };
}
