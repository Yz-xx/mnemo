import type { AppSettings } from '../preload/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DEFAULT_SETTINGS } from '../preload/types.js';

/** 设置文件放在用户数据目录，避免写入安装目录导致权限问题 */
const getSettingsFile = (): string => path.join(app.getPath('userData'), 'settings.json');

/** 读取设置并与默认值合并：文件缺失或损坏时整体回退默认值，避免半截配置带进运行期 */
export function readSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(getSettingsFile(), 'utf-8');
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    // 首次启动或文件损坏时回退默认值
    return { ...DEFAULT_SETTINGS };
  }
}

/** 写回设置：先与既有值合并再落盘，返回合并结果供调用方直接使用 */
export function writeSettings(settings: Partial<AppSettings>): AppSettings {
  const merged = { ...readSettings(), ...settings };
  fs.mkdirSync(path.dirname(getSettingsFile()), { recursive: true });
  fs.writeFileSync(getSettingsFile(), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}
