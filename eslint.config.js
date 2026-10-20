// ESLint 9 统一扁平配置（Flat Config）
// 全仓共用：JS 推荐规则 + TypeScript 推荐规则 + Vue3 推荐规则 + import 排序与未用导入清理，
// 并关闭与 Prettier 冲突的格式规则
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
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

  // 导入整理：声明顺序由 eslint-plugin-import-x 强制（替代原 @ianvs/prettier-plugin-sort-imports），
  // 未被引用的 import 由 unused-imports 整行删除；以 _ 开头的参数/变量表示有意忽略
  {
    plugins: {
      'import-x': importX,
      'unused-imports': unusedImports,
    },
    rules: {
      'unused-imports/no-unused-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 分组口径与原 .prettierrc.json 的 importOrder 保持一致：
      // 类型 → Node 内置 → 第三方 → @mnemo/* → @/* → 相对路径，组内按大小写不敏感升序
      'import-x/order': [
        'error',
        {
          groups: [
            'type',
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
            'object',
            'unknown',
          ],
          // pathGroups 的 group 只接受内置枚举，无法自定义组名，因此 @mnemo/* 与 @/* 同归 internal，
          // 靠列表先后配合 position: before 维持「@mnemo 在前、@/ 在后」的既有顺序
          pathGroups: [
            { pattern: '@mnemo/**', group: 'internal', position: 'before' },
            { pattern: '@/**', group: 'internal', position: 'before' },
          ],
          // 只把 type 排除在外：否则 import type 会命中 pathGroups 被拉进 internal，破坏「类型声明置顶」
          pathGroupsExcludedImportTypes: ['type'],
          alphabetize: { order: 'asc', caseInsensitive: true },
          // 组间空行不作规定，避免引入原先 prettier 未强制的空行标准
          'newlines-between': 'ignore',
        },
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
    files: ['apps/admin-web/src/pages/**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },

  // 关闭所有与 Prettier 冲突的格式类规则
  prettier,
);
