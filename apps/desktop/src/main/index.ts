import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import type { AppSettings, AppInfo, ThemeMode, WindowAction } from '../preload/types.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** 设置项默认值：本地开发时后端默认监听 3000 端口 */
const DEFAULT_SETTINGS: AppSettings = {
  backendUrl: 'http://localhost:3000',
  theme: 'dark',
};

/**
 * 窗口底色需与主题一致：窗口出现到首个渲染帧之间露出的是这个颜色，
 * 若固定为深色，亮色主题用户在启动时会看到一次深色闪烁。
 */
const WINDOW_BACKGROUND: Record<ThemeMode, string> = {
  dark: '#0d1011',
  light: '#f7f5f1',
};

/** 设置文件放在用户数据目录，避免写入安装目录导致权限问题 */
const getSettingsFile = (): string => path.join(app.getPath('userData'), 'settings.json');

function readSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(getSettingsFile(), 'utf-8');
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    // 首次启动或文件损坏时回退默认值
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings: Partial<AppSettings>): AppSettings {
  const merged = { ...readSettings(), ...settings };
  fs.mkdirSync(path.dirname(getSettingsFile()), { recursive: true });
  fs.writeFileSync(getSettingsFile(), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/**
 * 主题同步到 Electron 层：themeSource 决定渲染进程的 prefers-color-scheme，
 * 窗口底色决定首帧绘制前露出的颜色，两者都要跟随才能避免启动时的闪烁。
 */
function applyTheme(theme: ThemeMode): void {
  nativeTheme.themeSource = theme;
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(WINDOW_BACKGROUND[theme]);
  }
}

function createWindow(): void {
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

function registerIpcHandlers(): void {
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

// 单实例运行：重复启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    registerIpcHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
