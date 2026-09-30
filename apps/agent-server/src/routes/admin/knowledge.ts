import type { AppDependencies } from '../../configuration/dependencies.js';
import type { KnowledgeDocument } from '../../rag/index.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { currentAdmin } from '../../auth/middleware.js';
import { ERROR_MESSAGE } from '../../configuration/messages.js';
import { requestLogger } from '../../middleware/requestLog.js';
import {
  addDocument,
  describeAddFailure,
  describeUpdateFailure,
  parseDocumentInput,
  updateDocument,
} from '../../services/knowledge.js';
import { parsePaging } from '../pagination.js';
import { parseStringIds } from './batchIds.js';

/** 列表项：文档字段 + 归属账号名，前端据此显示「谁的文档」；全局文档为 null */
interface AdminDocument extends KnowledgeDocument {
  ownerName: string | null;
}

function toAdminDocument(document: KnowledgeDocument, names: Map<number, string>): AdminDocument {
  return {
    ...document,
    ownerName: document.ownerUserId === null ? null : (names.get(document.ownerUserId) ?? null),
  };
}

/**
 * 管理端知识库接口：以管理视角查看与维护全部文档（含各用户的私有文档）。
 * 挂在 /api/admin/knowledge，模块内部只写相对路径；鉴权由 routes/index.ts 统一挂 requireAdmin。
 */
export function createAdminKnowledgeRouter({
  knowledge,
  users,
}: Pick<AppDependencies, 'knowledge' | 'users'>): Router {
  const router = Router();

  /** 文档列表：按标题包含匹配 + 分页，私有文档带上归属账号名 */
  router.get('/documents', async (req: Request, res: Response) => {
    const { page, pageSize } = parsePaging(req.query);
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';

    // 文档存在 LanceDB 里，没有 SQL 分页；条数规模远小于用户表，取出后在内存过滤与分页
    const all = await knowledge.listAll();
    const lower = keyword.toLowerCase();
    const matched = lower
      ? all.filter((document) => document.title.toLowerCase().includes(lower))
      : all;
    const start = (page - 1) * pageSize;
    const items = matched.slice(start, start + pageSize);

    // 归属名一次批量取回：逐条查会让一页列表产生 N 次往返
    const ownerIds = items.flatMap((document) =>
      document.ownerUserId === null ? [] : [document.ownerUserId],
    );
    const names = await users.findNamesByIds(ownerIds);

    res.json({
      items: items.map((document) => toAdminDocument(document, names)),
      total: matched.length,
      page,
      pageSize,
    });
  });

  /** 文档内容：管理员可查看任意文档；旧文档无原文时按分片顺序拼接返回（source 标记） */
  router.get('/documents/:id/content', async (req: Request, res: Response) => {
    // Express 5 的 params 值类型为 string | string[]，路径参数实际只有单值，这里收窄
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    const admin = currentAdmin(res);
    const content = await knowledge.getContent(documentId, {
      userId: admin.userId ?? 0,
      isAdmin: true,
    });
    if (!content) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.DOCUMENT_NOT_FOUND });
      return;
    }

    const ownerIds = content.document.ownerUserId === null ? [] : [content.document.ownerUserId];
    const names = await users.findNamesByIds(ownerIds);
    res.json({
      document: toAdminDocument(content.document, names),
      content: content.content,
      source: content.source,
      updatedAt: content.updatedAt,
    });
  });

  /** 编辑文档：整体替换内容并重切分重向量化，id 与归属保持不变 */
  router.put('/documents/:id', async (req: Request, res: Response) => {
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    const parsed = parseDocumentInput(req.body);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }

    const admin = currentAdmin(res);
    try {
      const document = await updateDocument(
        knowledge,
        requestLogger(res),
        documentId,
        parsed.value,
        { userId: admin.userId ?? 0, isAdmin: true },
      );
      if (!document) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.DOCUMENT_NOT_FOUND });
        return;
      }
      const ownerIds = document.ownerUserId === null ? [] : [document.ownerUserId];
      const names = await users.findNamesByIds(ownerIds);
      res.json(toAdminDocument(document, names));
    } catch (error) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ message: describeUpdateFailure(error) });
    }
  });

  /** 新增全局文档：与客户端私有入口共用入参校验与入库编排 */
  router.post('/documents', async (req: Request, res: Response) => {
    const parsed = parseDocumentInput(req.body);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }

    try {
      const document = await addDocument(knowledge, requestLogger(res), {
        ...parsed.value,
        scope: 'global',
        // 全局文档不归属个人；超级令牌入口没有账号 ID，日志里用 0 表示「非账号操作」
        userId: currentAdmin(res).userId ?? 0,
      });
      res.status(HTTP_STATUS.CREATED).json({ ...document, ownerName: null });
    } catch (error) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ message: describeAddFailure(error) });
    }
  });

  /** 批量删除文档：管理员可删任意文档，逐条清理，已不存在的视为已完成（幂等） */
  router.post('/documents/batch-delete', async (req: Request, res: Response) => {
    const admin = currentAdmin(res);
    const ids = parseStringIds(((req.body ?? {}) as { ids?: unknown }).ids);
    if (!ids) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: ERROR_MESSAGE.BATCH_IDS_STRING });
      return;
    }

    for (const id of ids) {
      await knowledge.remove(id, { userId: admin.userId ?? 0, isAdmin: true });
    }
    requestLogger(res).info('管理端批量删除文档', {
      count: ids.length,
      operator: admin.userId,
      superToken: admin.superToken,
    });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  /** 删除文档：管理员可删任意文档（含他人私有），不可逆故留一条业务日志 */
  router.delete('/documents/:id', async (req: Request, res: Response) => {
    const admin = currentAdmin(res);
    // Express 5 的 params 值类型为 string | string[]，路径参数实际只有单值，这里收窄
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    const removed = await knowledge.remove(documentId, {
      userId: admin.userId ?? 0,
      isAdmin: true,
    });
    if (!removed) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.DOCUMENT_NOT_FOUND });
      return;
    }
    requestLogger(res).info('管理端删除文档', {
      documentId,
      operator: admin.userId,
      superToken: admin.superToken,
    });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  return router;
}
