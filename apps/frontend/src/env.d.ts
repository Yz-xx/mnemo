/// <reference types="vite/client" />

// 让 TypeScript 能够识别 .vue 单文件组件的类型
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
