---
description: 本仓库 TypeScript、Vue、Less 的编写与命名注释规范，含 Prettier 与 ESLint 配置约定、抽象复用准则、单元测试组织方式。编写、重构或评审代码时遵守。
globs: apps/**,packages/**,scripts/**
alwaysApply: false
---

# 代码编写规范

## 1. 格式化与静态检查

规则以配置为准，不要另立标准：

- Prettier（`.prettierrc.json`）：单引号、语句末尾分号、`printWidth: 100`、`tabWidth: 2`、`trailingComma: all`、`arrowParens: always`、`endOfLine: lf`。
- ESLint 为扁平配置（`eslint.config.js`）：`js.configs.recommended` + `typescript-eslint` recommended + `eslint-plugin-vue` flat/recommended + `eslint-plugin-import-x`（`import-x/order` 管导入排序、`unused-imports/no-unused-imports` 管未用导入），末尾接 `eslint-config-prettier` 关闭所有格式类规则。
- 有意忽略的参数或变量用 `_` 前缀（如 Express 错误中间件的 `_req`、`_next`），由 `argsIgnorePattern` / `varsIgnorePattern` 放行。
- `.vue` 文件中 `no-undef` 已关闭，类型由 TS 编译器负责，不要为类型名添加 eslint 抑制注释。
- Node 环境全局变量仅对 `scripts/**`、`apps/agent-server/**`、桌面端 `main`/`preload`、各类配置文件开放，渲染进程代码不得依赖 Node 全局。
- 提交前跑 `pnpm run lint`（必要时 `pnpm run lint:fix`），不手工调整行宽或引号以迎合个人习惯。

## 2. TypeScript

- 导出的函数显式标注返回类型（如 `: Promise<void>`、`: void`）；一次性内部回调可省略。
- 类型导入一律带类型标记：只导类型时用 `import type { ... }`，与值同模块混导时用行内 `type` 修饰符（如 `import { AgentApi, isUnauthorized, type HealthInfo } from '../api/client'`）。**`import type` 行统一集中在文件最上方**（其内部由 `alphabetize` 按路径排序，不再按来源分组），其后是值导入，按模块来源分段：Node 内置 → 第三方 → 仓库内模块（`@mnemo/*` 与 `@/*` 别名）→ 相对路径，组内按路径大小写不敏感升序。顺序由 `eslint.config.js` 的 `import-x/order` 强制（`groups` 首项为 `type`，`@mnemo/*` 与 `@/*` 经 `pathGroups` 归入 `internal`），`pnpm lint:fix` 自动修复，无需手写。
- 类型导出与导入同口径：**`export type { ... } from '...'` 统一集中在文件最上方**，其后才是值导出 `export { ... } from '...'`；聚合入口文件（`index.ts`）尤须如此。
- 对象结构用 `interface`（如 `AppDependencies`、`ChatStreamHandlers`），联合与工具类型用 `type`。
- 不用 `any`；外部不可信输入用 `unknown`，并在系统边界收窄。
- 少用 `as` 断言，仅允许出现在边界（如 `req.body`、`JSON.parse` 结果）。
- 常量用 `UPPER_SNAKE_CASE`（`SESSION_TTL_MS`、`DEFAULT_TITLE`），仅模块内部使用时不导出；函数与变量用 camelCase。
- 命名对应关系：后端文件 camelCase（`sessionStore.ts`、`chatStream.ts`）、`components/` 下组件目录与组件文件 PascalCase（`components/SettingsDrawer/SettingsDrawer.vue`）、根组件为单文件 `App.vue`、组件私有 composable `useXxx.ts`、公共样式文件 kebab（`theme.less`）。
- 不可变优先：用展开构造新对象或数组，不原地修改共享状态。
- 单一职责：一个文件只承担一件事；函数接近 60 行或出现第二类职责时，按"编排 / 展示 / 数据"拆成独立模块。
- 目录内已有同类实现时沿用其模式（工厂函数 + 参数注入、Store 类等），不引入第二种风格。

## 3. 注释

- 全部使用中文。
- 导出项（函数、类型、常量）用 `/** */` JSDoc 说明用途，重点写"为什么这样设计"与边界条件，不复述代码表面行为。
- 非显然写法或绕过坑点处用行内 `//` 交代原因，例如"监听 res 而非 req，req 的 close 在请求体读取完成后就会触发，会误中断流式响应"。
- 不为显而易见的代码加注释；被替代的实现直接删除，不保留注释掉的代码。
- 留待后续处理的用 `TODO:` 前缀，并写明原因与预期做法。

## 4. Vue 3

- 一律 `<script setup lang="ts">` 加泛型 `defineProps` / `defineEmits`，不使用 Options API。
- 组件只负责展示与交互；请求、持久化、跨组件共享状态放 `composables/useXxx.ts`。
- composable 内部状态用 `ref` / `computed`，需要跨组件共享时用模块级单例（参考 `useAuth`），对外只暴露只读状态与操作函数。
- 父子通信走 props 与 emit，子组件不直接改父级状态。
- 模板类名遵循 BEM（`块__元素`、`块--修饰`）；`components/` 下的组件以目录组织（`Xxx/{index.ts, Xxx.vue, Xxx.less, useXxx.ts}`），私有样式写同目录 `Xxx.less` 并由 `.vue` 以 `<style src="./Xxx.less" lang="less" scoped>` 引入；根组件 `App.vue` 例外，保持单文件与内联 scoped 样式块。
- `pages/` 下超过 200 行的页面按同一口径拆：`<目录>/index.vue` 只留模板与 `useXxxPage()` 的分组解构，逻辑进同目录 `<目录>.ts`（导出 `useXxxPage()`），其余关注点进同目录 `useXxx<关注点>.ts`（导出子 hook）；样式进同目录 `<目录>.less`；根目录两页的 `.ts`/`.less` 与 `.vue` 并排命名（总览页 `overview.ts`、登录页 `login.ts`）。页面**不设 `index.ts` 导出**——路由由 `.vue` 生成、页面不被别处 import。
- **hook 出口收敛到约 5 个绑定**：页面入口 `useXxxPage()`（以及被 `.vue` 直接消费的 hook）顶层只返回 ≤5 个分组；硬判据就是 `<script setup>` 里 `const { a, b, ... } = useXxx()` 的顶层绑定数。超出就按关注点拆成同目录子 hook 分组返回：子 hook 各持有自己关注点的状态、只暴露该关注点用到的绑定，**彼此不互相 import**，共享状态与回调由入口创建后经参数注入。子 hook 是拆出来的内部关注点，键数随该关注点实际需要（一个关注点内不得混入无关绑定；某组明显臃肿就说明关注点还能再切一刀）。入口把子 hook 收成 ≤5 个分组（如 `filter` / `table` / `selection` / `dialog` / `cells`），模板按组访问（`table.rows`、`dialog.kind`），层级不超过两层；模板用得到的常量放进对应分组，纯函数与常量仍留模块顶层。
- 分组对象**必须用 `reactive()` 包**：嵌套在普通对象里的 `ref` 在模板中不会被解包，不包就会把 ref 对象本身交给模板。参考实现见 `apps/admin-web/src/pages/users/`（入口 + `useUsersDialog.ts` + `useUsersSelection.ts`）。
- 页面私有状态（含 `usePagedList` 建出的 ref）必须留在 `useXxxPage()` 内部：写在模块顶层会脱离组件实例，`onMounted` 失效、状态还会跨路由进出被复用。模块顶层只放静态常量与纯函数。
- 列表渲染必须写 `:key`；模板中出现多套条件分支时抽子组件，不堆叠 `v-if`。
- 需要即时反映的流式数据（token 追加）通过独立 `ref` 承载，避免整列表重建。

## 5. Less 与样式

- 变量用 kebab-case：`@sidebar-width`、`@radius-sm`、`@theme-transition`；CSS 自定义属性同理 `--bg-panel`。
- 色值一律走 CSS 变量（`--bg`、`--text`、`--accent`、`--danger` 等），禁止在组件里写死颜色。
- 可复用片段抽成 mixin（`.ellipsis()`、`.focus-ring()`、`.content-gutter()`），仅在确有多个调用方时才抽取。
- 设计令牌集中维护：与主题无关的尺寸、时长、字体放 `styles/variables.less`；色板放 `styles/theme.less`；mixin 放 `styles/mixins.less`；组件样式块用 `@import (reference)` 引入，避免重复输出。
- `components/` 下组件的私有样式写在组件目录的 `Xxx.less` 中，由 `.vue` 以 `<style src="./Xxx.less" lang="less" scoped>` 引入（根组件 `App.vue` 用内联 `<style lang="less" scoped>`）；只有被两个及以上组件复用的样式才提炼到 `styles/`，并按层叠顺序在 `styles/index.less` 注册。
- `v-html` 注入的内容不带 scoped 属性，覆盖其标签样式须用 `:deep()` 穿透。
- 选择器保持 BEM 风格与浅层嵌套（不超过 2 层），避免滥用后代选择器。
- 动效时长需与 TS 常量对齐时，在两侧注释互相指明（如 `@theme-transition` 对应 `useTheme.ts` 的 `TRANSITION_MS`）。

## 6. 单元测试

- 测试文件统一放所属包或应用的 `src/__vitest__/` 下，命名 `*.test.ts`，并在该包 `tsconfig.json` 的 `exclude` 中排除，避免进入构建产物。
- 只测纯逻辑与边界（解析、校验、存储编排），外部依赖用替身隔离（参考 `FakeEmbeddings`），不连真实数据库与网络。
- 用例描述用中文，一个 `it` 只验证一个行为；覆盖正常路径、边界与失败路径。
- 新增或修改用例后执行 `pnpm --filter <包名> run test` 确认通过。

## 7. 通用准则

- 改动最小化：只动与任务相关的代码，不顺手重构无关文件。
- 先复用再抽象：同一逻辑出现第三次或是有可能被其它地方复用的干净代码时才抽公共能力，不为一次性需求造抽象、配置项或兼容分支。
- 生成代码前先读同目录既有实现，保持命名、分层与注释风格一致。
- 交活前自检：`pnpm run lint` 与 `pnpm test`，涉及构建链路再补 `pnpm build`。
