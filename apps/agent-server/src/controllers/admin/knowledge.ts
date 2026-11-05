import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { SHARED_KNOWLEDGE_BASE_ID } from '../../infrastructure/db/schema/knowledgeBases.js';
import { currentAdmin } from '../../middleware/auth.js';
import { requestLogger } from '../../middleware/requestLog.js';
import {
  attachOwnerNames,
  listAllBases,
  removeBaseAsAdmin,
} from '../../services/admin/adminKnowledge.js';
import {
  addDocument,
  describeAddFailure,
  describeUpdateFailure,
  parseDocumentInput,
  updateDocument,
} from '../../services/knowledge/index.js';
import { parseStringIds } from '../../utils/batchIds.js';
import { parsePaging } from '../../utils/pagination.js';
import { keywordParam, pathParam } from '../../utils/request.js';

/**
 * 管理端知识库接口：以管理视角查看与维护全部库与文档（含各用户的私有库）。
 * 挂在 /api/admin/knowledge，模块内部只写相对路径；鉴权由 controllers/index.ts 统一挂 requireAdmin。
 */
export function createAdminKnowledgeRouter({
  knowledge,
  knowledgeBases,
  knowledgeIngest,
  users,
}: Pick<AppDependencies, 'knowledge' | 'knowledgeBases' | 'knowledgeIngest' | 'users'>): Router {
  const router = Router();

  /** 库列表：全部库（含各用户私有库）+ 每库文档数与归属账号名，供后台库维度管理 */
  router.get('/bases', async (_req: Request, res: Response) => {
    res.json(await listAllBases(knowledgeBases, users));
  });

  /** 删除库：管理端不限制归属；文档与片段级联删除，会话绑定回落为不限库 */
  router.delete('/bases/:id', async (req: Request, res: Response) => {
    const baseId = pathParam(req.params.id);
    // 级联删除只管数据库行：原始文件要提前取到文档清单，删库成功后再逐个清理
    const documents = await knowledge.list(baseId);
    const removed = await removeBaseAsAdmin(knowledgeBases, requestLogger(res), baseId);
    if (!removed) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    await Promise.all(documents.map((document) => knowledgeIngest.discard(document.id)));
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  /** 文档列表：按标题包含匹配 + 分页，私有文档带上归属账号名 */
  router.get('/documents', async (req: Request, res: Response) => {
    const { page, pageSize } = parsePaging(req.query);
    const keyword = keywordParam(req.query.keyword);

    // 文档列表没有分页查询接口；条数规模远小于用户表，取出后在内存过滤与分页
    const all = await knowledge.listAll();
    const lower = keyword.toLowerCase();
    const matched = lower
      ? all.filter((document) => document.title.toLowerCase().includes(lower))
      : all;
    const start = (page - 1) * pageSize;

    // 归属名经「文档 → 所属库 → 账号名」批量解析，一次取回整页
    const items = await attachOwnerNames(
      knowledgeBases,
      users,
      matched.slice(start, start + pageSize),
    );

    res.json({
      items,
      total: matched.length,
      page,
      pageSize,
    });
  });

  /** 文档内容：管理员可查看任意文档；旧文档无原文时按分片顺序拼接返回（source 标记） */
  router.get('/documents/:id/content', async (req: Request, res: Response) => {
    const documentId = pathParam(req.params.id);
    const admin = currentAdmin(res);
    const content = await knowledge.getContent(documentId, {
      userId: admin.userId ?? 0,
      isAdmin: true,
    });
    if (!content) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.DOCUMENT_NOT_FOUND });
      return;
    }

    const [view] = await attachOwnerNames(knowledgeBases, users, [content.document]);
    res.json({
      document: view,
      content: content.content,
      source: content.source,
      updatedAt: content.updatedAt,
    });
  });

  /** 编辑文档：整体替换内容并重切分重向量化，id 与归属保持不变 */
  router.put('/documents/:id', async (req: Request, res: Response) => {
    const documentId = pathParam(req.params.id);
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
      const [view] = await attachOwnerNames(knowledgeBases, users, [document]);
      res.json(view);
    } catch (error) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ message: describeUpdateFailure(error) });
    }
  });

  /** 新增共享库文档：与客户端私有入口共用入参校验与入库编排，目标固定为共享库 */
  router.post('/documents', async (req: Request, res: Response) => {
    const parsed = parseDocumentInput(req.body);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }

    try {
      const document = await addDocument(knowledge, requestLogger(res), {
        ...parsed.value,
        knowledgeBaseId: SHARED_KNOWLEDGE_BASE_ID,
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
      if (await knowledge.remove(id, { userId: admin.userId ?? 0, isAdmin: true })) {
        // 行删除成功后一并清理原始文件：解析任务回写会被存储层拦下，不会复活已删文档
        await knowledgeIngest.discard(id);
      }
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
    const documentId = pathParam(req.params.id);
    const removed = await knowledge.remove(documentId, {
      userId: admin.userId ?? 0,
      isAdmin: true,
    });
    if (!removed) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.DOCUMENT_NOT_FOUND });
      return;
    }
    await knowledgeIngest.discard(documentId);
    requestLogger(res).info('管理端删除文档', {
      documentId,
      operator: admin.userId,
      superToken: admin.superToken,
    });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  return router;
}
