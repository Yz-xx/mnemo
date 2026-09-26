/// <reference types="vite/client" />

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
  }
}
