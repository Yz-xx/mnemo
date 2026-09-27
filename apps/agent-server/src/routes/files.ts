import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { HTTP_STATUS } from '@repo/reusable';
import { currentUserId } from '../auth/middleware.js';
import type { AppDependencies } from '../dependencies.js';
import { detectUploadType } from '../files/type.js';
import { createUploadMiddleware } from '../middleware/upload.js';

/** 展示用文件名的保留长度：只存数据库、不参与拼路径，截断是为免超出列宽与界面排版 */
const NAME_MAX_LENGTH = 180;

/** 本模块用到的依赖：文件存储与上传配置 */
type FilesDependencies = Pick<AppDependencies, 'files' | 'config'>;

/** 文件接口：上传与按 ID 下载（下载同时服务于应用户要求由智能体生成的导出文件） */
export function createFilesRouter(deps: FilesDependencies): Router {
  const router = Router();

  router.post('/', createUploadMiddleware(deps.config.upload), (req, res) =>
    handleUploadFile(deps, req, res),
  );
  router.get('/:id/download', (req, res) => handleDownloadFile(deps, req, res));

  return router;
}

/**
 * 还原 multer 按 latin1 解码出的文件名，并剥掉客户端可能带上的目录部分。
 * busboy 默认以 latin1 解 filename，UTF-8 中文名到这里会是乱码，需按原字节重解一次；
 * 只取 basename：原始名完全由客户端控制，不能让路径分隔符进入后续展示与下载命名。
 */
function normalizeFileName(raw: string): string {
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return path.basename(decoded).slice(0, NAME_MAX_LENGTH);
}

/**
 * 下载入口：按当前用户取回字节，查不到（含不属于该用户）即 404。
 * 一律以附件形式回传，浏览器调试环境下也不会把未知类型直接渲染成页面。
 */
export async function handleDownloadFile(
  { files }: FilesDependencies,
  // 路由参数在默认注解下是 string | string[]（通配参数可为多值），这里固定是单值 ID
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const loaded = await files.read(currentUserId(res), req.params.id);
  if (!loaded) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ message: '文件不存在或已失效' });
    return;
  }
  res.setHeader('Content-Type', loaded.file.mime);
  // 文件名可能是中文：按 RFC 5987 用 filename* 传递，响应头里就不会出现非 ASCII 字符
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(loaded.file.name)}`,
  );
  res.send(loaded.bytes);
}

/** 上传入口：magic bytes 判定类型 → 白名单校验 → 落盘并写元数据 */
export async function handleUploadFile(
  { files, config }: FilesDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  const upload = req.file;
  if (!upload) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '请选择要上传的文件' });
    return;
  }

  // 类型一律按文件头判定：扩展名与 MIME 由客户端提交，不可信
  const detected = await detectUploadType(upload.buffer);
  if (!detected || !config.upload.allowedTypes.includes(detected.ext)) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ message: '不支持该文件类型' });
    return;
  }

  const stored = await files.save(currentUserId(res), {
    name: normalizeFileName(upload.originalname),
    ext: detected.ext,
    mime: detected.mime,
    bytes: upload.buffer,
  });
  res.status(HTTP_STATUS.CREATED).json(stored);
}
