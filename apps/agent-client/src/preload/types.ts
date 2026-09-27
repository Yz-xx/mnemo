// 主进程与渲染进程共享的桥接契约：桥接类型 + 设置项默认值。
// 放在 preload 是因为它是主进程与渲染进程共同引用的一层：默认值只在这里写一份，
// 两边各写一份必然漂移（浏览器调试环境用的地址会与主进程读到的地址不一致）。

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

/** 设置项默认值：本地开发时后端默认监听 3000 端口 */
export const DEFAULT_SETTINGS: AppSettings = {
  backendUrl: 'http://localhost:3000',
  theme: 'dark',
  authToken: '',
};

/** 运行环境信息，用于界面展示与问题排查 */
export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

/**
 * 用户在系统文件对话框中选中的附件。
 * 字节随桥接一并回传：渲染进程没有读本地文件的能力，只有拿到原始内容才能构造上传表单，
 * 而路径本身在渲染侧毫无用处，传了反而多暴露一份本机目录结构。
 */
export interface SelectedFile {
  /** 原始文件名，用于界面展示与上传时的表单文件名 */
  name: string;
  /** 字节数，用于界面展示 */
  size: number;
  bytes: Uint8Array;
}

/**
 * 需要写到本地的导出文件：字节由渲染进程从后端下载得到，主进程负责落盘。
 * 与 SelectedFile 同构但语义相反：一个是读进来的，一个是写出去的，故不复用同一类型。
 */
export interface ExportedFile {
  /** 建议文件名（含扩展名），作为系统保存对话框的默认名 */
  name: string;
  bytes: Uint8Array;
}

/** 主进程通过 contextBridge 暴露给渲染进程的能力 */
export interface DesktopApi {
  /** 预加载阶段同步读取的设置快照，用于在首帧渲染前确定主题 */
  initialSettings: AppSettings;
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  /** 打开系统文件对话框挑选附件；用户取消时返回 null */
  openFile(): Promise<SelectedFile | null>;
  /** 打开系统保存对话框写出导出文件，返回最终写入路径；用户取消时返回 null */
  saveFile(file: ExportedFile): Promise<string | null>;
  windowControl(action: WindowAction): void;
}

export type WindowAction = 'minimize' | 'maximize' | 'close';
