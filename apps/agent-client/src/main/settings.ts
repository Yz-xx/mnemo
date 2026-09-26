import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppSettings } from '../preload/types.js';

/** 设置项默认值：本地开发时后端默认监听 3000 端口 */
export const DEFAULT_SETTINGS: AppSettings = {
  backendUrl: 'http://localhost:3000',
  theme: 'dark',
  authToken: '',
};

/** 设置文件放在用户数据目录，避免写入安装目录导致权限问题 */
const getSettingsFile = (): string => path.join(app.getPath('userData'), 'settings.json');

export function readSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(getSettingsFile(), 'utf-8');
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    // 首次启动或文件损坏时回退默认值
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(settings: Partial<AppSettings>): AppSettings {
  const merged = { ...readSettings(), ...settings };
  fs.mkdirSync(path.dirname(getSettingsFile()), { recursive: true });
  fs.writeFileSync(getSettingsFile(), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}
