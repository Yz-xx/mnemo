import { BrowserWindow, nativeTheme } from 'electron';
import type { ThemeMode } from '../preload/types.js';

/**
 * 窗口底色需与主题一致：窗口出现到首个渲染帧之间露出的是这个颜色，
 * 若固定为深色，亮色主题用户在启动时会看到一次深色闪烁。
 * 取值必须与 styles/theme.less 的 --bg 一致（黑金：暖墨黑 / 象牙金：象牙纸）。
 */
export const WINDOW_BACKGROUND: Record<ThemeMode, string> = {
  dark: '#0c0b09',
  light: '#f7f3ea',
};

/**
 * 主题同步到 Electron 层：themeSource 决定渲染进程的 prefers-color-scheme，
 * 窗口底色决定首帧绘制前露出的颜色，两者都要跟随才能避免启动时的闪烁。
 */
export function applyTheme(theme: ThemeMode): void {
  nativeTheme.themeSource = theme;
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(WINDOW_BACKGROUND[theme]);
  }
}
