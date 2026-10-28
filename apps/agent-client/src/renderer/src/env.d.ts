/// <reference types="vite/client" />

import type { RenderPerfSnapshot } from './perf/renderMetrics';
import type { DesktopApi } from '../../preload/types.js';

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入 */
    desktopApi: DesktopApi;
    /** 渲染性能采集入口，仅开发模式安装（见 docs/adr/0016 阶段 0） */
    __mnemoPerf?: {
      snapshot: () => RenderPerfSnapshot;
      reset: () => void;
    };
  }
}
