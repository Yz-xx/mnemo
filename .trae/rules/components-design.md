---
description: @mnemo/components 组件库规范：适用边界与收录判据、@layer 样式契约、--ui-* 令牌契约、组件写法、构建与消费、自检清单。目录结构、令牌清单与核心文件模板见 docs/adr/0007。
globs: packages/components/**
---

# 组件库规范

## 1. 适用边界

组件库服务于仓库内的 web 前端应用（当前 admin-web，及后续新增的 web 应用），**不含桌面端 agent-client**。包声明 `private: true`，不发布、不背版本兼容包袱、不写 CHANGELOG。

收录判据与 `packages/reusable` 同源——**换一个 web 应用它还用得上吗**。具体：

- 只收展示型组件：接收 props、回传事件，不自己取数、不自己跳路由。
- 不收依赖 `@mnemo/reusable` 的组件。HTTP 状态码语义、SSE 对话协议、固定文案都是本业务约定，绑上就不通用。
- 不收直接调后端接口的组件。取数与状态由消费方注入，组件只管呈现。
- 组件库不依赖任何应用代码，`apps/*` 一律不 import。
- 应用私有逻辑留在应用内，不上提。

## 2. 样式契约：级联层

### 规则

- 组件库**所有**样式（含令牌默认值）必须完整包在 `@layer mnemo-components { … }` 内。每个 `.less` 文件各自包裹，不靠构建期注入。
- 只用 `mnemo-components` 一个层名。不新增层，不写 `@layer a, b;` 这类顺序声明。
- 禁止 `!important`。
- 禁止依赖消费方的导入顺序。

### 原理

CSS 级联按「来源与重要性 → 层顺序 → 特异性 → 出现顺序」逐级比较。未分层的普通样式**恒优先于**任何分层样式，所以消费方写一条最普通的 `.ui-page-bar__button { … }` 就能覆盖组件库，既不需要提高特异性，也不需要 `!important`，更与 `style.css` 导入在哪一行无关。

`scoped` 会给组件库选择器追加 `[data-v-*]`，特异性高于消费方的裸类名——但层级比较发生在特异性之前，覆盖依然成立。防泄漏靠 `scoped`，可覆盖性靠层级，两件事各管一头。

### 消费方覆盖的三种方式

| 目的               | 写法                                         |
| ------------------ | -------------------------------------------- |
| 换主题色 / 尺寸    | `:root { --ui-primary: #…; }`                |
| 调单个组件         | `.ui-page-bar__button { … }`（未分层即生效） |
| 穿透 scoped 作用域 | `:deep(.ui-page-bar__input) { … }`           |

消费方若也想用自己的层组织样式，在入口声明 `@layer mnemo-components, app;`，之后把自身样式写进 `@layer app { … }`，app 层便恒高于组件库。不声明照样能覆盖，声明只是让消费方的层组织更清晰。

## 3. 令牌契约

- 组件库样式**只消费 `--ui-*` 变量**，禁止写死色值、圆角、时长（同 code-style 第 5 节）。
- 默认值集中声明在 `src/styles/tokens.less` 的层内 `:root`，形式为 `--ui-<名>: var(--<消费方同名>, <兜底值>)`。
- 先吸附消费方的同名令牌，缺失时回落兜底值——组件库因此在任何环境下都能独立渲染，同时自动跟随应用主题。
- 要单独调组件库而不动全局时，覆盖 `--ui-*`。
- 新增令牌按同一形式追加到 `tokens.less`，不要散落到组件样式里就地定义。

令牌清单与 `tokens.less` 完整内容见 [ADR 0007](../../docs/adr/0007-component-library-style-encapsulation.md)。

## 4. 组件写法

- 组件目录名与组件名一致（PascalCase），目录下按 `X.vue` / `X.less` / `useX.ts` / `index.ts` 组织；逻辑与样式不长时 `useX.ts` 不必建——不为假设的未来预留文件。
- 根类名 `ui-` + kebab-case：`ui-page-bar`；子元素 `ui-page-bar__button`；状态修饰 `ui-page-bar--compact`。`ui-` 前缀保证不与消费方类名相撞。
- `index.ts` 统一写 `export { default } from './X.vue'`。
- `.vue` 只留模板与绑定解构，页面级私有状态写进 `useX()`；逻辑超过 200 行时按关注点外提到同目录 `.ts`。
- props 用 `withDefaults(defineProps<Props>())`，emits 用类型化 `defineEmits<{ … }>()`；对外事件名用 kebab-case。
- 组件之间不互相 import。共用逻辑上提到 `src/composables/`，避免形成组件依赖图。
- 不引入第三方 UI 库。图标由消费方经 slot 传入，组件库不自带图标依赖。
- 带第三方运行时依赖的组件（如图表）须把该依赖写进 `peerDependencies`，并加入 `vite.config.ts` 的 `external`。
- 纯逻辑（`composables/` 与组件外提的 `.ts`）应有单元测试，放 `src/__vitest__/`，与仓库 vitest 约定一致。

目录结构与核心文件模板见 [ADR 0007](../../docs/adr/0007-component-library-style-encapsulation.md)。

## 5. 构建与消费

`pnpm build` 由根脚本先构建 `packages/*`，组件库产物为 `dist/index.mjs`、`dist/index.cjs`、`dist/index.d.ts`、`dist/components.css`。

消费方接入三步：

1. `pnpm add @mnemo/components --filter @mnemo/admin-web`
2. 入口导入样式：`import '@mnemo/components/style.css';`——**放在哪一行都行**。
3. 具名引入 `import { PageBar } from '@mnemo/components'`，或 `app.use(Components)` 全局注册。

## 6. 自检清单

- 每个 `.less` 文件（含 `tokens.less`）都被 `@layer mnemo-components { … }` 完整包裹。
- 组件库内无 `!important`，无 `@layer` 顺序声明，无第二个层名。
- 样式里出现的颜色、圆角、时长、字体均来自 `--ui-*`，无字面量。
- 根类名带 `ui-` 前缀，子元素与修饰符走 BEM。
- 组件不 import `@mnemo/reusable`，不 import `apps/*`，不调后端接口。
- 新增第三方运行时依赖已进 `peerDependencies` 与 `vite.config.ts` 的 `external`。
- 收尾跑 `pnpm run lint` + `pnpm test`，涉及构建链路再补 `pnpm build`。
