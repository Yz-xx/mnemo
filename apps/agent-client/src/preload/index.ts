import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, DesktopApi, WindowAction } from './types.js';

// 同步读取一次设置：主题需要在页面首帧渲染前确定，异步 IPC 来不及
const initialSettings = ipcRenderer.sendSync('settings:get-sync') as AppSettings;

// 仅暴露白名单方法，渲染进程无法直接访问 Node / Electron 能力
const desktopApi: DesktopApi = {
  initialSettings,
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  windowControl: (action: WindowAction) => ipcRenderer.send('window:control', action),
};

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
