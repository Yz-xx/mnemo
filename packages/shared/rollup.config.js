// 公共库 Rollup 打包配置：同时产出 CJS / ESM 两种模块格式及 TypeScript 类型声明
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/index.ts',
  output: [
    { file: 'dist/index.cjs', format: 'cjs', sourcemap: true },
    { file: 'dist/index.mjs', format: 'esm', sourcemap: true },
  ],
  // 工具库暂无第三方运行时依赖，node_modules 中的包统一外置
  external: [/node_modules/],
  plugins: [
    resolve(),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: true,
      declarationDir: 'dist/types',
      // 仅类型产物需要声明，JS 已由 Rollup 输出，关闭冗余发射
      emitDeclarationOnly: false,
    }),
  ],
};
