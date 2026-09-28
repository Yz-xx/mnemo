// ESLint 9 统一扁平配置（Flat Config）
// 全仓共用：JS 推荐规则 + TypeScript 推荐规则 + Vue3 推荐规则，并关闭与 Prettier 冲突的格式规则
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 全局忽略：构建产物、依赖目录与 Trae 规则目录（仅含 Markdown）
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.trae/**',
    ],
  },

  // JS / TS 通用基础规则
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Vue3 单文件组件规则（自带 vue-eslint-parser）
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        // <script lang="ts"> 交由 TypeScript 解析器处理
        parser: tseslint.parser,
      },
    },
    rules: {
      // TypeScript 编译器本身负责未定义变量校验，no-undef 无法识别 TS 类型（如 MouseEvent）
      'no-undef': 'off',
    },
  },

  // 以 _ 开头的参数/变量表示有意忽略（如 Express 错误中间件的未用参数）
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Node 环境：脚本、后端、Electron 主进程与预加载脚本及各类配置文件
  {
    files: [
      'scripts/**/*.js',
      'apps/agent-server/**/*.ts',
      'apps/agent-client/src/main/**/*.ts',
      'apps/agent-client/src/preload/**/*.ts',
      '*.config.js',
      '**/*.config.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },

  // 路由页文件名（index / login / [...all] 等）由 unplugin-vue-router 按文件系统约定解析，
  // 不需要多词组件名，对 pages 目录关闭 multi-word-component-names
  {
    files: ['apps/frontend/src/pages/**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },

  // 放在最后，确保关闭所有与 Prettier 冲突的格式类规则
  prettier,
);
