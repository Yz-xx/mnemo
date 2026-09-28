import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Electron 三段式构建配置：主进程 / 预加载 / 渲染进程
export default defineConfig({
  // 主进程与预加载运行在 Node 环境，依赖交由运行时 require，避免被打包进产物
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  // 渲染进程即普通 Vue 页面
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      },
    },
  },
});
