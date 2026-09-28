import type {
  AppSettings,
  DesktopApi,
  ExportedFile,
  SelectedFile,
} from '../../../preload/types.js';
import { DEFAULT_SETTINGS } from '../../../preload/types.js';

// 渲染进程访问 preload 桥接的唯一入口。
// 浏览器调试环境（如样式预览页）不存在 window.desktopApi，所有读写统一在此降级，
// 避免各 composable 与组件各写一份 `as DesktopApi | undefined` 与默认值。

/** 后端服务默认地址：登录页、对话客户端与设置项共用同一份 */
export const DEFAULT_BACKEND_URL = DEFAULT_SETTINGS.backendUrl;

// 桥接要么全程存在、要么全程缺失，因此只在模块加载时判定一次
const bridge = window.desktopApi as DesktopApi | undefined;

/** 首帧前的设置快照（由 preload 同步注入）；无桥接时用默认值，保证主题与地址仍有确定值 */
export const initialSettings: AppSettings = bridge?.initialSettings ?? { ...DEFAULT_SETTINGS };

/** 读取设置；无桥接时返回默认值 */
export async function readSettings(): Promise<AppSettings> {
  return (await bridge?.getSettings()) ?? { ...DEFAULT_SETTINGS };
}

/** 写入设置；无桥接时只返回合并结果而不落盘（浏览器调试不保留状态是预期行为） */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (!bridge) return { ...DEFAULT_SETTINGS, ...patch };
  return bridge.saveSettings(patch);
}

/** 打开文件对话框挑选附件；浏览器调试环境没有该能力，一律按“未选择”处理 */
export async function openFile(): Promise<SelectedFile | null> {
  return (await bridge?.openFile()) ?? null;
}

/** 写出导出文件到本地；无桥接（浏览器调试环境）或用户取消时返回 null */
export async function saveFile(file: ExportedFile): Promise<string | null> {
  return (await bridge?.saveFile(file)) ?? null;
}
