// 主进程与渲染进程共享的桥接类型（纯类型文件，不产生运行时代码）

/** 界面主题 */
export type ThemeMode = 'dark' | 'light';

/** 应用可持久化的设置项 */
export interface AppSettings {
  /** 后端智能体服务地址 */
  backendUrl: string;
  /** 界面主题，由主进程持有以便窗口底色在首帧前即正确 */
  theme: ThemeMode;
  /** 登录令牌，由登录页写入，用于下次启动恢复登录态；为空表示未登录 */
  authToken: string;
}

/** 运行环境信息，用于界面展示与问题排查 */
export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

/** 主进程通过 contextBridge 暴露给渲染进程的能力 */
export interface DesktopApi {
  /** 预加载阶段同步读取的设置快照，用于在首帧渲染前确定主题 */
  initialSettings: AppSettings;
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  windowControl(action: WindowAction): void;
}

export type WindowAction = 'minimize' | 'maximize' | 'close';
