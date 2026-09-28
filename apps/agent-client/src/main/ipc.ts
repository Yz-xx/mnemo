import type {
  AppInfo,
  AppSettings,
  ExportedFile,
  SelectedFile,
  WindowAction,
} from '../preload/types.js';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readSettings, writeSettings } from './settings.js';
import { applyTheme } from './theme.js';

/**
 * 附件对话框的扩展名过滤：与后端默认的 UPLOAD_ALLOWED_TYPES 对应。
 * 这里只是给人看的筛选条件，真正的类型判定由后端按文件头做，前端过滤不承担安全职责。
 */
const ATTACHMENT_FILTERS: OpenDialogOptions['filters'] = [
  { name: '文档与图片', extensions: ['docx', 'xlsx', 'pdf', 'png', 'jpg', 'jpeg'] },
];

/** 注册主进程 IPC：应用信息、设置读写、附件选择与无边框窗口控制 */
export function registerIpcHandlers(): void {
  ipcMain.handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));

  ipcMain.handle('settings:get', (): AppSettings => readSettings());
  ipcMain.handle('settings:save', (_event, settings: Partial<AppSettings>): AppSettings => {
    const merged = writeSettings(settings);
    applyTheme(merged.theme);
    return merged;
  });

  // 预加载阶段同步读取设置，让主题在首帧渲染前即可确定
  ipcMain.on('settings:get-sync', (event) => {
    event.returnValue = readSettings();
  });

  // 选择附件：由主进程读原始字节后再回传，渲染进程没有读本地文件的能力
  ipcMain.handle('dialog:open', async (event): Promise<SelectedFile | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: '选择要发送的文件',
      properties: ['openFile'],
      filters: ATTACHMENT_FILTERS,
    };
    // 有窗口时挂成模态，避免对话框跑到窗口后面去
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const [filePath] = result.filePaths;
    if (result.canceled || !filePath) return null;

    const bytes = await fs.readFile(filePath);
    return { name: path.basename(filePath), size: bytes.length, bytes };
  });

  // 保存导出文件：同样由主进程写盘，渲染进程手里只有后端回传的字节
  ipcMain.handle('dialog:save', async (event, file: ExportedFile): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: SaveDialogOptions = { title: '保存文件', defaultPath: file.name };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;

    await fs.writeFile(result.filePath, file.bytes);
    return result.filePath;
  });

  // 无边框窗口的自定义控制按钮
  ipcMain.on('window:control', (event, action: WindowAction) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
  });
}
