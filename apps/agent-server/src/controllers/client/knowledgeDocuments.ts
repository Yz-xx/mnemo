import type { KnowledgeDependencies } from './knowledgeSupport.js';
import type { KnowledgeFileContext } from '../../services/knowledge/index.js';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Router } from 'express';
import { HTTP_STATUS } from '@mnemo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { SHARED_KNOWLEDGE_BASE_ID } from '../../infrastructure/db/schema/knowledgeBases.js';
import { currentUserId } from '../../middleware/auth.js';
import { requestLogger } from '../../middleware/requestLog.js';
import { createUploadMiddleware } from '../../middleware/upload.js';
import {
  acceptKnowledgeUpload,
  addDocument,
  describeAddFailure,
  findManageableBase,
  findVisibleBase,
  parseDocumentInput,
  readDocumentPreview,
  retryKnowledgeDocument,
} from '../../services/knowledge/index.js';
import { actorOf, isAdminRequest, readParam } from './knowledgeSupport.js';

/**
 * 文档子路由：列表 / 详情 / 上传 / 重试 / 入库 / 删除。
 * 与库 CRUD 拆开只为守住单文件行数上限，对外仍由 createKnowledgeRouter 统一挂载。
 */
export function createKnowledgeDocumentRouter(deps: KnowledgeDependencies): Router {
  const router = Router();
  // 上传与重试的校验 / 落盘 / 建记录 / 入队都收在服务层，路由只做归属校验与状态码
  const fileContext: KnowledgeFileContext = {
    knowledge: deps.knowledge,
    ingest: deps.knowledgeIngest,
    uploadDir: deps.config.upload.dir,
  };

  /** 库内文档列表：先验库可见，再按库列出 */
  router.get('/bases/:id/documents', async (req, res) => {
    const base = await findVisibleBase(
      deps.knowledgeBases,
      currentUserId(res),
      readParam(req, 'id'),
    );
    if (!base) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    res.json(await deps.knowledge.list(base.id));
  });

  /** 文档详情：解析状态与失败原因供前端轮询；文档必须属于路径中的库 */
  router.get('/bases/:id/documents/:docId', async (req, res) => {
    const base = await findVisibleBase(
      deps.knowledgeBases,
      currentUserId(res),
      readParam(req, 'id'),
    );
    const document = base
      ? await deps.knowledge.findVisible(readParam(req, 'docId'), actorOf(deps.config, res))
      : null;
    if (!base || !document || document.knowledgeBaseId !== base.id) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    res.json(document);
  });

  /**
   * 文档预览：文本类返回解析后全文，二进制类流式输出原始文件。
   * 预览不重跑解析，也不整读内存：PDF 常有几十兆，整读会挤占并发额度。
   */
  router.get('/documents/:id/preview', async (req, res) => {
    const actor = actorOf(deps.config, res);
    const document = await deps.knowledge.findVisible(readParam(req, 'id'), actor);
    if (!document) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }

    const preview = await readDocumentPreview(
      { knowledge: deps.knowledge, uploadDir: deps.config.upload.dir },
      document,
      actor,
    );
    if (preview.kind === 'missing') {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: '原始文件不存在或已被删除' });
      return;
    }
    if (preview.kind === 'text') {
      res.json(preview);
      return;
    }

    res.setHeader('Content-Type', preview.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(preview.fileName)}`,
    );
    const stream = createReadStream(preview.filePath);
    stream.on('error', (error) => {
      // 响应头已写出，无法再改状态码；断流并留日志，避免把截断的 PDF 当成完整文件
      requestLogger(res).warn('文档预览流读取失败', { documentId: document.id, error });
      res.destroy();
    });
    stream.pipe(res);
  });

  /**
   * 文件上传：multipart 落临时文件后交给服务层。
   * 接口只等「上传完成」，解析完成由状态轮询体现（上传完成 ≠ 解析完成）。
   */
  router.post(
    '/bases/:id/documents/file',
    createUploadMiddleware(deps.config.upload),
    async (req, res) => {
      const upload = req.file;
      if (!upload) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '请选择要上传的文件' });
        return;
      }

      const base = await findManageableBase(
        deps.knowledgeBases,
        currentUserId(res),
        readParam(req, 'id'),
      );
      if (!base) {
        // 库不可写也要清掉 multer 已落下的临时文件，避免无主文件堆在 .tmp
        await fs.rm(upload.path, { force: true });
        res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
        return;
      }

      const result = await acceptKnowledgeUpload(fileContext, requestLogger(res), base.id, upload);
      if (result.kind === 'invalid') {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ message: result.message });
        return;
      }
      if (result.kind === 'failed') {
        res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ message: result.message });
        return;
      }
      res.status(HTTP_STATUS.CREATED).json(result.document);
    },
  );

  /** 重试解析：仅 failed 文档可重试，状态判断与重置入队由服务层完成 */
  router.post('/documents/:id/retry', async (req, res) => {
    const result = await retryKnowledgeDocument(
      deps.knowledge,
      deps.knowledgeIngest,
      readParam(req, 'id'),
      actorOf(deps.config, res),
    );
    if (result.kind === 'notFound') {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    if (result.kind === 'notRetryable') {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '仅解析失败的文档可重试' });
      return;
    }
    res.json(result.document);
  });

  /** 文档入库入口：目标库维护权校验与状态码在此，切分向量化编排交给服务层 */
  async function createDocument(
    req: Request,
    res: Response,
    knowledgeBaseId: string,
  ): Promise<void> {
    // 校验与默认标题收在服务层：两个入库入口（私有库 / 管理令牌共享库）共用同一套口径
    const parsed = parseDocumentInput(req.body);
    if (!parsed.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: parsed.message });
      return;
    }

    try {
      const document = await addDocument(deps.knowledge, requestLogger(res), {
        ...parsed.value,
        knowledgeBaseId,
      });
      res.status(HTTP_STATUS.CREATED).json(document);
    } catch (error) {
      // 同类失败对外只有 500 一种状态码（backend-design 第 3 章）
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ message: describeAddFailure(error) });
    }
  }

  /** 向私有库入库：仅归属者可写自己的库，global 库客户端不可写 */
  router.post('/bases/:id/documents', async (req, res) => {
    const base = await findManageableBase(
      deps.knowledgeBases,
      currentUserId(res),
      readParam(req, 'id'),
    );
    if (!base) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    await createDocument(req, res, base.id);
  });

  /** 管理令牌向共享库（global）入库：令牌未配置或不匹配按不存在处理，不暴露该接口的存在 */
  router.post('/global/documents', async (req, res) => {
    if (!isAdminRequest(deps.config, req)) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: ERROR_MESSAGE.NOT_FOUND });
      return;
    }
    await createDocument(req, res, SHARED_KNOWLEDGE_BASE_ID);
  });

  /** 删除文档：维护权按所在库判定（服务层），权限不足按「不存在」处理 */
  router.delete('/documents/:id', async (req, res) => {
    const documentId = readParam(req, 'id');
    const userId = currentUserId(res);
    const admin = isAdminRequest(deps.config, req);
    const removed = await deps.knowledge.remove(documentId, { userId, isAdmin: admin });
    if (!removed) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: '文档不存在或无权删除' });
      return;
    }
    // 行删掉后解析任务回写会被存储层拦下；这里再取消在途任务并清原始文件，避免磁盘残留
    await deps.knowledgeIngest.discard(documentId);
    // 删除不可逆，留一条业务记录便于回溯是谁操作了共享库文档
    requestLogger(res).info('文档已删除', { documentId, userId, isAdmin: admin });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  return router;
}
