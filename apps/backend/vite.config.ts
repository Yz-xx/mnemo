// 后端应用打包配置（Vite，服务端构建）：把 src 下的 TypeScript 源码打成单个 ESM 产物 dist/index.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// 服务端产物不打包 node_modules：运行时依赖（含 workspace 包 @repo/shared）与 Node 内置模块一律外置
const external = [
  /^node:/,
  ...Object.keys(pkg.dependencies ?? {}).map((name) => new RegExp(`^${name}(/|$)`)),
];

export default defineConfig({
  // 目录下的 .env.* 是给 node --env-file 运行时读取的，与打包无关，关闭 Vite 自身的 env 加载
  envDir: false,
  build: {
    // 服务端构建：按 Node 环境解析依赖与内建模块，不走浏览器相关的产物逻辑
    ssr: true,
    // 产物只在 Node 20 及以上运行，无需像浏览器产物那样向下兼容
    target: 'node20',
    // 服务端产物去掉空格与注释，仅保留可执行代码；sourcemap 仍可还原原始源码
    minify: 'esbuild',
    sourcemap: true,
    // 产物为单文件，构建前清空 dist，避免上一次的编译产物残留
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      external,
      output: {
        format: 'es',
        // 与 package.json 的 type: module 及 start 脚本保持一致
        entryFileNames: 'index.js',
      },
    },
  },
});
