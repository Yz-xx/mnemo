import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, shell } from 'electron';
import { readSettings } from './settings.js';
import { applyTheme, WINDOW_BACKGROUND } from './theme.js';

// 主进程产物所在目录，用于定位预加载脚本与渲染页面
const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** 创建主窗口：首屏渲染完成后再显示，避免白屏闪烁 */
export function createWindow(): void {
  const { theme } = readSettings();
  applyTheme(theme);

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: WINDOW_BACKGROUND[theme],
    title: 'AI Agent Desktop',
    webPreferences: {
      // 预加载产物在 type: module 下输出为 .mjs
      preload: path.join(currentDir, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 首屏渲染完成后再显示，避免白屏闪烁
  mainWindow.on('ready-to-show', () => mainWindow.show());

  // 外部链接交由系统默认浏览器打开，避免在应用内新开窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(currentDir, '../renderer/index.html'));
  }
}
