import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeActor,
  KnowledgeDocument,
  KnowledgeUpload,
} from '../../entities/knowledge.js';
import type { Logger } from '@repo/logger';
import { toErrorMessage } from '@repo/shared';

/** 标题缺省值：客户端私有入口与管理端全局入口共用，默认标题保持一致 */
const DEFAULT_DOCUMENT_TITLE = '未命名文档';

/** 整理后的入库入参：校验与默认值都已完成，服务层可直接入库 */
export interface DocumentInput {
  title: string;
  content: string;
}

/**
 * 整理文档入参：内容为空视为非法（由路由翻成 400），标题缺省为「未命名文档」。
 * 两个入库入口（客户端私有 / 管理端全局）共用，改动校验口径时只需改这一处。
 */
export function parseDocumentInput(
  body: unknown,
): { ok: true; value: DocumentInput } | { ok: false; message: string } {
  const raw = (body ?? {}) as { title?: unknown; content?: unknown };
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!content) return { ok: false, message: '文档内容不能为空' };
  const title =
    typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : DEFAULT_DOCUMENT_TITLE;
  return { ok: true, value: { title, content } };
}

/** 入库失败的对外文案：状态码仍是 500，文案保留具体原因，便于判断是不是向量化服务没起来 */
export function describeAddFailure(error: unknown): string {
  return `文档入库失败：${toErrorMessage(error)}`;
}

/** 编辑失败的对外文案：失败场景与入库同源（向量化服务未启动、基准不符），前缀随操作区分 */
export function describeUpdateFailure(error: unknown): string {
  return `文档编辑失败：${toErrorMessage(error)}`;
}

/**
 * 文档入库编排：切分与向量化都在 KnowledgeStore 内完成，这里只负责计时与日志。
 * 归属范围由调用方（路由）按入口决定：客户端只能写私有，全局走管理入口。
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

/**
 * 文档编辑编排：重切分与重向量化在 KnowledgeStore 内完成，这里只负责计时与日志。
 * 返回 null 表示文档不存在或无权限，由路由翻成 404；
 * 抛错时保留原始错误落日志再抛回，状态码与对外文案由路由决定（失败场景与入库同源）
 */
export async function updateDocument(
  knowledge: KnowledgeStore,
  logger: Logger,
  id: string,
  input: { title: string; content: string },
  actor: KnowledgeActor,
): Promise<KnowledgeDocument | null> {
  const startedAt = Date.now();
  try {
    const document = await knowledge.replace(id, input, actor);
    if (document) {
      logger.info('文档编辑完成', {
        documentId: document.id,
        title: document.title,
        chunkCount: document.chunks,
        durationMs: Date.now() - startedAt,
        userId: actor.userId,
      });
    }
    return document;
  } catch (error) {
    logger.error('文档编辑失败', {
      documentId: id,
      title: input.title,
      durationMs: Date.now() - startedAt,
      userId: actor.userId,
      error,
    });
    throw error;
  }
}
