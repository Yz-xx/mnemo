import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Vite 配置：Vue 插件 + workspace 公共包源码别名 + 后端接口代理
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@repo/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@repo/components': fileURLToPath(
        new URL('../../packages/components/src/index.ts', import.meta.url),
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
