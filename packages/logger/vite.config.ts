// 公共库打包配置（Vite 库模式）：产出 CJS / ESM 双格式产物及 TypeScript 类型声明
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// 第三方运行时依赖由使用方安装，外置时保留裸包名；Node 内置模块同样外置，不打进产物
const external = [
  /^node:/,
  ...Object.keys(pkg.dependencies ?? {}).map((n) => new RegExp(`^${n}(/|$)`)),
];

export default defineConfig({
  plugins: [
    // 类型声明输出到 dist 下并保留源码目录结构，与 package.json 的 types 字段对应；
    // 扫描范围沿用 tsconfig.json 的 include / exclude（测试目录已被排除）
    dts({ tsconfigPath: './tsconfig.json' }),
  ],
  build: {
    // 与 tsconfig.base.json 的 target 保持一致，不对语法做额外降级
    target: 'es2022',
    // 库产物保留空格与注释，便于使用方调试与定位问题
    minify: false,
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.mjs' : 'index.cjs'),
    },
    rollupOptions: { external },
  },
});
