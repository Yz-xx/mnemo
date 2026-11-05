import type { KnowledgeDependencies } from './knowledgeSupport.js';
import { Router } from 'express';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { currentUserId } from '../../middleware/auth.js';
import { requestLogger } from '../../middleware/requestLog.js';
import {
  createBase,
  findVisibleBase,
  listBases,
  parseBaseInput,
  parseBasePatch,
  removeBase,
  updateBase,
} from '../../services/knowledge/index.js';
import { createKnowledgeDocumentRouter } from './knowledgeDocuments.js';
import { readParam } from './knowledgeSupport.js';

/**
 * 客户端知识库接口：库 CRUD 与文档相关路由（/api/knowledge）。
 * 库可见性：global 全员可读、private 仅归属者；维护权（建 / 改 / 删 / 上传）只属于私有库归属者，
 * global 库（共享库）只能由管理令牌写入（见 docs/adr/0018 决策 7）。
 */
export function createKnowledgeRouter(deps: KnowledgeDependencies): Router {
  const router = Router();

  /** 库列表：当前用户可见的库 + 每库文档数 */
  router.get('/bases', async (_req, res) => {
    res.json(await listBases(deps.knowledgeBases, currentUserId(res)));
  });

  /** 新建私有库：客户端不可建 global 库，visibility 由服务层固定 */
  router.post('/bases', async (req, res) => {
    const parsed = parseBaseInput(req.body);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }
    const base = await createBase(
      deps.knowledgeBases,
      requestLogger(res),
      currentUserId(res),
      parsed.value,
    );
    res.status(HTTP_STATUS.CREATED).json(base);
  });

  /** 库详情：不可见（含不存在）一律 404，不泄漏他人库是否存在 */
  router.get('/bases/:id', async (req, res) => {
    const base = await findVisibleBase(
      deps.knowledgeBases,
      currentUserId(res),
      readParam(req, 'id'),
    );
    if (!base) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    res.json(base);
  });

  /** 编辑库：改名 / 改描述，仅归属者；global 库不可编辑（按不存在处理） */
  router.patch('/bases/:id', async (req, res) => {
    const id = readParam(req, 'id');
    // PATCH 语义：只校验并写入出现过的字段，未出现的保持原值
    const parsed = parseBasePatch(req.body);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }
    const updated = await updateBase(
      deps.knowledgeBases,
      requestLogger(res),
      currentUserId(res),
      id,
      parsed.value,
    );
    if (!updated) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    res.json(updated);
  });

  /** 删除库：仅归属者可删私有库；库内文档随之级联删除，二次确认由客户端承担 */
  router.delete('/bases/:id', async (req, res) => {
    const removed = await removeBase(
      deps.knowledgeBases,
      deps.knowledge,
      deps.knowledgeIngest,
      requestLogger(res),
      currentUserId(res),
      readParam(req, 'id'),
    );
    if (!removed) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  // 文档相关路由独立成模块：单文件行数达标，对外入口保持不变
  router.use(createKnowledgeDocumentRouter(deps));

  return router;
}
