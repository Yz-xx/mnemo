import { app, BrowserWindow, ipcMain } from 'electron';
import type { AppInfo, AppSettings, WindowAction } from '../preload/types.js';
import { readSettings, writeSettings } from './settings.js';
import { applyTheme } from './theme.js';

/** 注册主进程 IPC：应用信息、设置读写与无边框窗口控制 */
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
