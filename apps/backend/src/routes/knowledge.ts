import { Router } from 'express';
import type { KnowledgeStore } from '../rag/store.js';

/** 知识库接口：文档入库会同步完成切分与向量化 */
export function createKnowledgeRouter(knowledge: KnowledgeStore): Router {
  const router = Router();

  router.get('/documents', (_req, res) => {
    res.json(knowledge.list());
  });

  router.post('/documents', async (req, res) => {
    const body = req.body as { title?: string; content?: string };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) {
      res.status(400).json({ message: '文档内容不能为空' });
      return;
    }

    try {
      const document = await knowledge.add({
        title: body.title?.trim() || '未命名文档',
        content,
      });
      res.status(201).json(document);
    } catch (error) {
      // 向量化依赖本地 embedding 服务，失败时给出可读提示
      const detail = error instanceof Error ? error.message : String(error);
      res.status(502).json({ message: `文档向量化失败：${detail}` });
    }
  });

  router.delete('/documents/:id', (req, res) => {
    if (!knowledge.remove(req.params.id)) {
      res.status(404).json({ message: '文档不存在' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
