# 组件库用级联层封装样式，令牌默认吸附消费方

`@repo/components` 的样式要和消费方的样式共存，就必须回答"谁覆盖谁"。传统做法把答案压在特异性或导入顺序上，前者要求消费方写出更狠的选择器，后者要求消费方记住 `import '@repo/components/style.css'` 得排在自己的样式之前——都是通用库对消费方提要求。本文记录改用 CSS 级联层（`@layer`）后的样式契约，以及随之确定的令牌命名与吸附策略。

## 现状

- 组件库目前只有脚手架示例 `MyButton.vue`，未被任何应用引用；admin-web 的 9 个组件仍留在应用内，样式各写各的。
- admin-web 的 `main.ts` 只 `import './styles/base.less'`（其中 `@import './tokens.less'`），`:root` 里的设计令牌是未分层的普通声明。
- 组件库 `private: true`，不发布到 npm；消费方只有仓库内的 web 应用（admin-web 及后续新增），桌面端 agent-client 不在其列。
- 组件库的构建产物是单个 CSS 文件，由消费方显式导入。CSS 无法随 JS 自动注入，所以"消费方要导入一次样式"这件事无法取消，只能让导入位置不再有意义。

## 决策

1. **全部样式包进 `@layer repo-components`**。源码里每个样式文件（令牌与组件样式）各自用该 at-rule 完整包裹，不靠构建期注入。
2. **只用这一个层名**，不新增层，也不声明层顺序。消费方无需写任何 `@layer`。
3. **令牌走 `--ui-*` 命名空间**，默认值声明在层内的 `:root`，取值形如 `--ui-text: var(--text, #14181f)`——先吸附消费方的同名令牌，缺失时回落兜底值。
4. **组件样式保留 `scoped`**。防泄漏靠它，可覆盖性靠层级，两件事分开。
5. **仍走 Vite 库模式产出 `dist`**，与 `@repo/shared` / `@repo/reusable` 一致。

级联层的规则是：未分层的普通样式恒优先于任何分层样式。于是消费方写一条最普通的 `.ui-page-bar__button { … }` 就能覆盖组件库，与特异性无关，与 `style.css` 的导入位置也无关。

## Considered Options

- **强制导入顺序**：实现零成本，但把通用库的内部约束转嫁给了每个消费方，且失效是静默的——有人调整 import 顺序就出问题，不报错。否决。
- **消费方提高特异性或上 `!important`**：覆盖成本随组件库选择器变化，组件库改一次选择器，消费方可能就要跟着改。否决。
- **组件库样式统一用 `:where()` 包裹降特异性**：效果接近，但每个选择器都得改写，且 `:where()` 不适用于 `:root` 上的令牌声明；`@layer` 一次包裹覆盖整个文件。否决。
- **不构建 `dist`，直接暴露 `src` 源码入口**：既然不发布，消费方的 Vite 本就能编译 Vue SFC 与 Less，可省掉构建步骤。但会偏离仓库「`pnpm build` 先构建 packages 再构建 apps」的既有链路，产物也不再带类型声明。否决。
- **用 PostCSS 插件在构建末期自动包裹 `@layer`**：源码干净，但包裹发生在 SFC scoped 编译之前还是之后难以确定，风险高于收益。否决，改为显式包裹。

## Consequences

- **覆盖有三档**：改令牌（`--ui-*`，一次改全局）、改类名（`.ui-*`，未分层即生效）、`:deep()`（穿透 scoped）。
- **组件库内禁止 `!important`**：它会把消费方的覆盖能力一并压掉，与层级的用意相抵。
- **令牌吸附是隐式耦合**：`--ui-text` 默认读 `--text`，消费方改全局令牌会连带改变组件库外观。这是刻意的——内部仓库里组件库本就该跟随应用主题；要单独调组件库则覆盖 `--ui-*`。
- **消费方若自己也用层**：需在入口声明 `@layer repo-components, app;`，让 app 层恒高于组件库。不声明照样能覆盖，声明只是让消费方自己的层组织更清晰。
- **浏览器下限**：`@layer` 需 Chrome / Edge 99+、Firefox 97+、Safari 15.4+，远低于本项目三个 web 应用的构建目标。
- **样式文件多两行样板**：每个 `.less` 顶部与底部各一行包裹。换来的是读文件即知层级，不依赖构建期魔法。

## 落地形态

### 目录结构

```text
packages/components/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md                     # 收录清单、消费方式、覆盖令牌的示例
└── src/
    ├── index.ts                  # 统一出口：具名导出 + 插件 install
    ├── env.d.ts                  # *.vue 模块声明
    ├── styles/
    │   └── tokens.less           # --ui-* 默认值（层内）
    ├── composables/              # 跨组件复用的组合式函数，无则不必建
    │   └── useXxx.ts
    ├── __vitest__/               # composable 的单元测试，按被测模块组织
    │   └── useXxx.test.ts
    └── components/
        └── PageBar/
            ├── PageBar.vue       # 模板 + 绑定解构 + <style src>
            ├── PageBar.less      # 层内样式
            ├── usePageBar.ts     # 逻辑超过 200 行时外提
            └── index.ts
```

### 令牌清单

默认值集中在 `src/styles/tokens.less` 的层内 `:root`，先吸附消费方同名令牌、缺失时回落兜底值。

| 令牌                  | 吸附               | 兜底值                               |
| --------------------- | ------------------ | ------------------------------------ |
| `--ui-font-body`      | `--font-body`      | 系统中文族                           |
| `--ui-font-mono`      | `--font-mono`      | 等宽族                               |
| `--ui-bg`             | `--bg`             | `#ffffff`                            |
| `--ui-bg-panel`       | `--bg-panel`       | `#f6f7f9`                            |
| `--ui-bg-hover`       | `--bg-hover`       | `#eef0f3`                            |
| `--ui-text`           | `--text`           | `#14181f`                            |
| `--ui-text-muted`     | `--text-muted`     | `#545c68`                            |
| `--ui-text-inverse`   | `--text-inverse`   | `#ffffff`                            |
| `--ui-border`         | `--border`         | `#e4e7eb`                            |
| `--ui-border-strong`  | `--border-strong`  | `#cfd4da`                            |
| `--ui-primary`        | `--primary`        | `#b8860b`                            |
| `--ui-primary-strong` | `--primary-strong` | `#8a6508`                            |
| `--ui-primary-soft`   | `--primary-soft`   | `#f5eddc`                            |
| `--ui-danger`         | `--danger`         | `#dc2626`                            |
| `--ui-danger-strong`  | `--danger-strong`  | `#b91c1c`                            |
| `--ui-danger-soft`    | `--danger-soft`    | `#fee2e2`                            |
| `--ui-success`        | `--success`        | `#16a34a`                            |
| `--ui-success-strong` | `--success-strong` | `#15803d`                            |
| `--ui-success-soft`   | `--success-soft`   | `#dcfce7`                            |
| `--ui-warning`        | `--warning`        | `#d97706`                            |
| `--ui-warning-strong` | `--warning-strong` | `#b45309`                            |
| `--ui-warning-soft`   | `--warning-soft`   | `#fef3c7`                            |
| `--ui-mask`           | `--mask`           | `rgba(20, 24, 31, 0.4)`              |
| `--ui-radius-sm`      | `--radius-sm`      | `2px`                                |
| `--ui-radius`         | `--radius`         | `3px`                                |
| `--ui-radius-lg`      | `--radius-lg`      | `4px`                                |
| `--ui-shadow`         | `--shadow`         | `0 12px 32px rgba(20, 24, 31, 0.12)` |
| `--ui-transition`     | `--transition`     | `150ms ease`                         |

### 核心文件模板

#### package.json

```json
{
  "name": "@repo/components",
  "version": "0.0.0",
  "private": true,
  "description": "跨 web 应用复用的 Vue 3 组件库（内部使用，不对外发布）",
  "type": "module",
  "sideEffects": ["**/*.css"],
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    },
    "./style.css": "./dist/components.css"
  },
  "files": ["dist"],
  "scripts": {
    "build": "vite build",
    "test": "vitest run --passWithNoTests"
  },
  "peerDependencies": {
    "vue": "^3.5.0"
  }
}
```

`sideEffects` 保留 CSS：消费方导入样式这一步不能被 tree-shaking 剔除。

#### vite.config.ts

```ts
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
```

#### tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue"]
}
```

#### src/index.ts

```ts
// 组件库统一出口：具名导出支持按需引入，默认导出支持 app.use() 全局注册
import type { App } from 'vue';
import PageBar from './components/PageBar';
import './styles/tokens.less';

export { PageBar };

const components = { PageBar };

export default {
  install(app: App): void {
    Object.entries(components).forEach(([name, component]) => {
      app.component(name, component);
    });
  },
};
```

#### src/styles/tokens.less

```less
// 组件库令牌默认值：统一声明在 repo-components 层内，
// 消费方未分层的 :root 覆盖自动生效（级联层优先于特异性）。
// 取值形式为「吸附消费方同名令牌 + 兜底值」：消费方改了 --text，
// 组件库外观随之改变；要单独调组件库则覆盖 --ui-*。
@layer repo-components {
  :root {
    --ui-font-body: var(--font-body, system-ui, -apple-system, 'Segoe UI', sans-serif);
    --ui-font-mono: var(--font-mono, ui-monospace, Consolas, monospace);

    --ui-bg: var(--bg, #ffffff);
    --ui-bg-panel: var(--bg-panel, #f6f7f9);
    --ui-bg-hover: var(--bg-hover, #eef0f3);

    --ui-text: var(--text, #14181f);
    --ui-text-muted: var(--text-muted, #545c68);
    --ui-text-inverse: var(--text-inverse, #ffffff);

    --ui-border: var(--border, #e4e7eb);
    --ui-border-strong: var(--border-strong, #cfd4da);

    --ui-primary: var(--primary, #b8860b);
    --ui-primary-strong: var(--primary-strong, #8a6508);
    --ui-primary-soft: var(--primary-soft, #f5eddc);

    // -strong 用于「深色语义字压浅色底」的场景（状态徽标、错误提示条）
    --ui-danger: var(--danger, #dc2626);
    --ui-danger-strong: var(--danger-strong, #b91c1c);
    --ui-danger-soft: var(--danger-soft, #fee2e2);
    --ui-success: var(--success, #16a34a);
    --ui-success-strong: var(--success-strong, #15803d);
    --ui-success-soft: var(--success-soft, #dcfce7);
    --ui-warning: var(--warning, #d97706);
    --ui-warning-strong: var(--warning-strong, #b45309);
    --ui-warning-soft: var(--warning-soft, #fef3c7);

    --ui-mask: var(--mask, rgba(20, 24, 31, 0.4));

    --ui-radius-sm: var(--radius-sm, 2px);
    --ui-radius: var(--radius, 3px);
    --ui-radius-lg: var(--radius-lg, 4px);

    --ui-shadow: var(--shadow, 0 12px 32px rgba(20, 24, 31, 0.12));

    --ui-transition: var(--transition, 150ms ease);
  }
}
```

#### src/components/PageBar/PageBar.vue

```vue
<script setup lang="ts">
// 分页条：上一页 / 下一页、页码信息与跳转，总页数由 total 与 pageSize 推出。
// 翻页经 update:page 回传，重新取数由调用方负责。
import { usePageBar } from './usePageBar';

const props = withDefaults(
  defineProps<{
    page: number;
    pageSize: number;
    total: number;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{
  'update:page': [page: number];
}>();

const { totalPages, jumpText, go, jump } = usePageBar(props, emit);
</script>

<template>
  <div class="ui-page-bar">
    <span class="ui-page-bar__info">共 {{ total }} 条 · 第 {{ page }} / {{ totalPages }} 页</span>
    <button
      class="ui-page-bar__button"
      type="button"
      :disabled="disabled || page <= 1"
      @click="go(page - 1)"
    >
      上一页
    </button>
    <button
      class="ui-page-bar__button"
      type="button"
      :disabled="disabled || page >= totalPages"
      @click="go(page + 1)"
    >
      下一页
    </button>
    <span class="ui-page-bar__jump">
      <input
        v-model="jumpText"
        class="ui-page-bar__input"
        type="text"
        inputmode="numeric"
        :disabled="disabled"
        @keyup.enter="jump"
      />
      <button class="ui-page-bar__button" type="button" :disabled="disabled" @click="jump">
        跳转
      </button>
    </span>
  </div>
</template>

<style src="./PageBar.less" lang="less" scoped></style>
```

#### src/components/PageBar/usePageBar.ts

```ts
import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';

// 分页条逻辑：页码收敛与跳转输入解析，与渲染无关，可独立测试
export function usePageBar(
  props: { page: number; pageSize: number; total: number; disabled: boolean },
  emit: (event: 'update:page', page: number) => void,
): {
  totalPages: ComputedRef<number>;
  jumpText: Ref<string>;
  go: (target: number) => void;
  jump: () => void;
} {
  const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));

  /** 目标页码收敛在 [1, totalPages]，越界点击不产生变化 */
  function go(target: number): void {
    const next = Math.min(Math.max(target, 1), totalPages.value);
    if (!props.disabled && next !== props.page) emit('update:page', next);
  }

  /** 跳转输入框的原始文本：只有确认跳转才解析，避免用户输入中途就触发取数 */
  const jumpText = ref('');

  function jump(): void {
    const raw = jumpText.value.trim();
    jumpText.value = '';
    if (raw === '') return;
    const target = Number(raw);
    if (Number.isInteger(target)) go(target);
  }

  return { totalPages, jumpText, go, jump };
}
```

#### src/components/PageBar/PageBar.less

```less
// 组件样式必须完整包在 repo-components 层内：
// 消费方任意未分层规则都能覆盖它，无需更高特异性或 !important
@layer repo-components {
  .ui-page-bar {
    display: flex;
    align-items: center;
    gap: 8px;

    &__info {
      margin-right: auto;
      color: var(--ui-text-muted);
      font-size: 13px;
    }

    &__input {
      width: 56px;
      height: 30px;
      padding: 0 6px;
      background-color: var(--ui-bg);
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius);
      color: var(--ui-text);
      text-align: center;
      transition: border-color var(--ui-transition);

      &:focus {
        border-color: var(--ui-primary);
        outline: none;
      }
    }

    &__button {
      height: 30px;
      padding: 0 12px;
      background-color: var(--ui-bg);
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius);
      color: var(--ui-text-muted);
      transition: all var(--ui-transition);

      &:hover:not(:disabled) {
        background-color: var(--ui-bg-hover);
        color: var(--ui-text);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
    }
  }
}
```

#### src/components/PageBar/index.ts

```ts
export { default } from './PageBar.vue';
```

#### src/env.d.ts

```ts
/// <reference types="vite/client" />

// 让 TypeScript 能够识别 .vue 单文件组件的类型
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
```

## 落地要点

- 已实测：Less 4 透传 `@layer`，嵌套 `&__b` 正确展开在层内；`@vue/compiler-sfc` 的 `scoped` 转换保留 `@layer` 结构，选择器正常追加 `[data-v-*]`，无编译错误。scoped 抬高的特异性不会破坏覆盖——层级先于特异性比较。
- 涉及文件：`packages/components/src/styles/tokens.less`（层内令牌默认值）、各组件 `X.less`（层内样式）、`vite.config.ts`（`build.lib.cssFileName: 'components'` 对齐 `exports` 的 `./style.css` 映射）、`package.json`（`sideEffects` 需保留 CSS）。
- 规范细则见 `.trae/rules/components-design.md`。
