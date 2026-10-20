import type { AppDependencies } from '../../configuration/dependencies.js';
import type { KnowledgeScope } from '../../entities/knowledge.js';
import type { KnowledgeStore } from '../../services/knowledge/index.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { currentUserId } from '../../middleware/auth.js';
import { requestLogger } from '../../middleware/requestLog.js';
import {
  addDocument,
  describeAddFailure,
  parseDocumentInput,
} from '../../services/knowledge/index.js';

/** 新增文档入口：只做入参校验（400）与状态码，入库编排交给服务层 */
async function createDocument(
  req: Request,
  res: Response,
  knowledge: KnowledgeStore,
  target: { scope: KnowledgeScope; userId: number },
): Promise<void> {
  // 校验与默认标题收在服务层：管理端全局入口共用同一套口径，避免两处各写一份
  const parsed = parseDocumentInput(req.body);
  if (!parsed.ok) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
    return;
  }

  try {
    const document = await addDocument(knowledge, requestLogger(res), {
      ...parsed.value,
      scope: target.scope,
      userId: target.userId,
    });
    res.status(HTTP_STATUS.CREATED).json(document);
  } catch (error) {
    // 同类失败对外只有 500 一种状态码（backend-design 第 3 章）
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ message: describeAddFailure(error) });
  }
}

/**
 * 知识库接口：文档入库会同步完成切分与向量化。
 * 客户端只能上传与删除自己的私有文档；全局共享文档由管理令牌校验的接口写入。
 */
export function createKnowledgeRouter({
  knowledge,
  config,
}: Pick<AppDependencies, 'knowledge' | 'config'>): Router {
  const router = Router();
  const adminToken = config.knowledge.adminToken;

  /** 管理令牌未配置时视为不开放全局文档写入 */
  const isAdmin = (req: Request): boolean =>
    adminToken !== '' && req.get('x-admin-token') === adminToken;

  router.get('/documents', async (_req, res) => {
    res.json(await knowledge.list(currentUserId(res)));
  });

  router.post('/documents', async (req, res) => {
    await createDocument(req, res, knowledge, { scope: 'private', userId: currentUserId(res) });
  });

  router.post('/global/documents', async (req, res) => {
    if (!isAdmin(req)) {
      // 权限不足按“不存在”处理（backend-design 第 4 章），不暴露该接口的存在
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    await createDocument(req, res, knowledge, { scope: 'global', userId: currentUserId(res) });
  });

  router.delete('/documents/:id', async (req, res) => {
    const userId = currentUserId(res);
    // 权限判定只算一次：删除与随后的日志都要用，避免同一次请求里重复比对令牌
    const admin = isAdmin(req);
    const removed = await knowledge.remove(req.params.id, { userId, isAdmin: admin });
    if (!removed) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: '文档不存在或无权删除' });
      return;
    }
    // 删除不可逆，留一条业务记录便于回溯是谁操作了全局文档
    requestLogger(res).info('文档已删除', {
      documentId: req.params.id,
      userId,
      isAdmin: admin,
    });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  return router;
}
