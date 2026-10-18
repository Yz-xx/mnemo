import type { AppDependencies } from '../../configuration/dependencies.js';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { ERROR_MESSAGE } from '../../common/messages.js';
import { currentAdmin } from '../../middleware/auth.js';
import { requestLogger } from '../../middleware/requestLog.js';
import { listAdminFiles } from '../../services/admin/adminFiles.js';
import { removeAnyFile } from '../../services/files.js';
import { parseStringIds } from '../../utils/batchIds.js';
import { parsePaging } from '../../utils/pagination.js';

/** 路径参数：Express 5 的值类型为 string | string[]，路径参数实际只有单值，这里收窄 */
function pathParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 管理端文件：以管理视角查看与清理全部用户的上传文件（元数据 + 落盘字节）。
 * 挂在 /api/admin/files，模块内部只写相对路径；鉴权由 controllers/index.ts 统一挂 requireAdmin。
 */
export function createAdminFilesRouter({
  files,
  users,
}: Pick<AppDependencies, 'files' | 'users'>): Router {
  const router = Router();

  /** 文件列表：按文件名包含匹配 + 分页，归属账号名一次批量还原 */
  router.get('/', async (req: Request, res: Response) => {
    const { page, pageSize } = parsePaging(req.query);
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const query = { keyword, page, pageSize };
    const result = await listAdminFiles({ files, users }, query);
    res.json(result);
  });

  /**
   * 批量删除文件：文件没有业务规则约束，按幂等处理——
   * 某条已不存在不会让整批失败，批量删除的意图本就是「这些都不该再存在」。
   */
  router.post('/batch-delete', async (req: Request, res: Response) => {
    const ids = parseStringIds(((req.body ?? {}) as { ids?: unknown }).ids);
    if (!ids) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ message: ERROR_MESSAGE.BATCH_IDS_STRING });
      return;
    }

    for (const id of ids) await removeAnyFile(files, id);
    requestLogger(res).info('管理端批量删除文件', {
      count: ids.length,
      operator: currentAdmin(res).userId,
    });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  /** 删除文件：元数据与落盘字节一并清理，不可逆故留一条业务日志 */
  router.delete('/:id', async (req: Request, res: Response) => {
    const id = pathParam(req.params.id);
    const removed = await removeAnyFile(files, id);
    if (!removed) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ message: '文件不存在' });
      return;
    }
    requestLogger(res).info('管理端删除文件', { fileId: id, operator: currentAdmin(res).userId });
    res.status(HTTP_STATUS.NO_CONTENT).end();
  });

  return router;
}
