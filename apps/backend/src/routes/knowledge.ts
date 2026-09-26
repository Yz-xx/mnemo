import { Router } from 'express';
import type { Request, Response } from 'express';
import { currentUserId } from '../auth/middleware.js';
import { toErrorMessage } from '../errors.js';
import { requestLogger } from '../middleware/requestLog.js';
import type { KnowledgeScope, KnowledgeStore } from '../rag/store.js';

/** 新增文档的公共流程：校验内容后入库，失败时给出可读提示 */
async function createDocument(
  req: Request,
  res: Response,
  knowledge: KnowledgeStore,
  target: { scope: KnowledgeScope; userId: number },
): Promise<void> {
  const body = req.body as { title?: string; content?: string };
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) {
    res.status(400).json({ message: '文档内容不能为空' });
    return;
  }
  const title = body.title?.trim() || '未命名文档';
  const startedAt = Date.now();

  try {
    const document = await knowledge.add({
      title,
      content,
      scope: target.scope,
      userId: target.userId,
    });
    requestLogger(res).info('文档入库完成', {
      documentId: document.id,
      title: document.title,
      scope: document.scope,
      chunkCount: document.chunks,
      durationMs: Date.now() - startedAt,
      userId: target.userId,
    });
    res.status(201).json(document);
  } catch (error) {
    // 向量化依赖本地 embedding 服务，维度或模型不符也在此统一提示
    const detail = toErrorMessage(error);
    // 入库失败集中在向量化服务与向量基准两类原因，必须把原始错误落日志才能定位
    requestLogger(res).error('文档入库失败', {
      title,
      scope: target.scope,
      userId: target.userId,
      durationMs: Date.now() - startedAt,
      error,
    });
    res.status(502).json({ message: `文档入库失败：${detail}` });
  }
}

/**
 * 知识库接口：文档入库会同步完成切分与向量化。
 * 客户端只能上传与删除自己的私有文档；全局共享文档由管理令牌校验的接口写入。
 */
export function createKnowledgeRouter(knowledge: KnowledgeStore, adminToken: string): Router {
  const router = Router();

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
      res.status(403).json({ message: '无权写入全局知识库' });
      return;
    }
    await createDocument(req, res, knowledge, { scope: 'global', userId: currentUserId(res) });
  });

  router.delete('/documents/:id', async (req, res) => {
    const removed = await knowledge.remove(req.params.id, {
      userId: currentUserId(res),
      isAdmin: isAdmin(req),
    });
    if (!removed) {
      res.status(404).json({ message: '文档不存在或无权删除' });
      return;
    }
    // 删除不可逆，留一条业务记录便于回溯是谁操作了全局文档
    requestLogger(res).info('文档已删除', {
      documentId: req.params.id,
      userId: currentUserId(res),
      isAdmin: isAdmin(req),
    });
    res.status(204).end();
  });

  return router;
}
