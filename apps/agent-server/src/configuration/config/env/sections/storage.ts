import type { AppConfig } from '../types.js';
import path from 'node:path';
import process from 'node:process';
import { toList, toNumber } from '../parsers.js';

/** 上传落盘：路径类配置一律绝对路径，默认落在数据目录下 */
export function loadUploadConfig(dataDir: string): AppConfig['upload'] {
  return {
    dir: process.env.UPLOAD_DIR ?? path.join(dataDir, 'uploads'),
    maxBytes: toNumber(process.env.UPLOAD_MAX_BYTES, 20 * 1024 * 1024),
    maxFiles: toNumber(process.env.UPLOAD_MAX_FILES, 1),
    allowedTypes: toList(process.env.UPLOAD_ALLOWED_TYPES, ['docx', 'xlsx', 'pdf', 'png', 'jpg']),
  };
}

/** 初始超管凭据：仅当库中没有任何后台侧账号时用它自举，留空即跳过并告警 */
export function loadInitialAdminConfig(): AppConfig['initialAdmin'] {
  return {
    username: process.env.INITIAL_ADMIN_USERNAME ?? '',
    password: process.env.INITIAL_ADMIN_PASSWORD ?? '',
  };
}
