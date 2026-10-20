import type { PluginOption } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import VueRouter from 'unplugin-vue-router/vite';
import { defineConfig } from 'vite';

// Vite 配置：
// - unplugin-vue-router 提供 src/pages 下的文件式自动路由
// - workspace 公共包源码别名（直接编译源码，无需先产出 dist）
// - /api 开头的请求代理到 Express 后端
export default defineConfig({
  plugins: [
    // unplugin-vue-router 的 Plugin 类型与本地 vite 实例因 @types/node peer 解析分裂而
    // 不兼容（同版本两实例），此处属构建配置边界，用断言对齐 PluginOption
    VueRouter({ routesFolder: 'src/pages' }) as PluginOption,
    vue(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 只别名真正用到的包：多留一条别名会让一次误 import 悄悄通过（把无关依赖拖进产物）
      '@mnemo/reusable': fileURLToPath(
        new URL('../../packages/reusable/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 前端以 /api 开头的请求代理到 Express 后端
      '/api': 'http://localhost:3000',
    },
  },
});
