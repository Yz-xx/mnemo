// 组件库打包（Vite 库模式）：产出 ESM / CJS 双格式、类型声明与独立 CSS
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [vue(), dts({ tsconfigPath: './tsconfig.json' })],
  build: {
    // 与 tsconfig.base.json 的 target 保持一致，不对语法做额外降级
    target: 'es2022',
    minify: false,
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'mjs' : 'cjs'}`,
      // 对齐 package.json 的 exports["./style.css"] 映射
      cssFileName: 'components',
    },
    rollupOptions: {
      // Vue 由宿主应用提供，避免重复打包
      external: ['vue'],
      output: { exports: 'named' },
    },
  },
});
