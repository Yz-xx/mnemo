// 业务可复用代码的打包配置（Vite 库模式）：产出 CJS / ESM 双格式产物及 TypeScript 类型声明
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

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
      // 本包目前无第三方依赖，单入口即可；将来若要引入带第三方依赖的业务能力，
      // 照 @repo/shared/crypto 的做法另开子路径入口，别让它进包根
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
  },
});
