// packages/* 的 Vite 库模式配置工厂：单入口、ESM + CJS 双格式、类型声明与依赖外置的口径集中在这里，
// 各包只传自身差异，避免三份配置各写一遍后逐年漂移。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

/**
 * @param {string} metaUrl 调用方的 import.meta.url：用于定位该包的 package.json 与入口文件
 * @param {{ externalNodeBuiltins?: boolean }} [options]
 *   externalNodeBuiltins 为 true 时把 node: 内置模块一并外置（Node 端库需要，浏览器端库不需要）
 * @returns {import('vite').UserConfig}
 */
export function defineLibConfig(metaUrl, { externalNodeBuiltins = false } = {}) {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', metaUrl), 'utf8'));

  // 第三方运行时依赖由使用方安装：外置时保留裸包名，不写成机器相关的绝对路径
  const external = [
    ...(externalNodeBuiltins ? [/^node:/] : []),
    ...Object.keys(pkg.dependencies ?? {}).map((name) => new RegExp(`^${name}(/|$)`)),
  ];

  return defineConfig({
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
        entry: fileURLToPath(new URL('./src/index.ts', metaUrl)),
        formats: ['es', 'cjs'],
        fileName: (format) => `index.${format === 'es' ? 'mjs' : 'cjs'}`,
      },
      rollupOptions: { external },
    },
  });
}
