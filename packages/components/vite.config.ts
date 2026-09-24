import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import dts from 'vite-plugin-dts';

// 组件库打包（Vite 库模式，底层为 Rollup）：产出 CJS / ESM 双格式与类型声明
export default defineConfig({
  plugins: [
    vue(),
    // 类型声明默认输出到 dist/index.d.ts，与 package.json 的 types 字段对应
    dts({
      include: ['src'],
      tsconfigPath: './tsconfig.json',
    }),
  ],
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.mjs' : 'index.cjs'),
    },
    sourcemap: true,
    rollupOptions: {
      // Vue 由宿主应用提供，避免重复打包
      external: ['vue'],
      output: {
        exports: 'named',
      },
    },
  },
});
