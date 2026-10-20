# @mnemo/components 公共组件库

跨 web 应用复用的展示型 Vue 3 组件库，当前供管理网站 `@mnemo/admin-web` 使用。包声明 `private: true`，**不发布、不对外提供**，因此不背版本兼容包袱、不写 CHANGELOG。桌面端 `agent-client` 不在服务范围内。

**收录判据**：换一个 web 应用它还用得上吗。用不上，说明它绑定了本业务（HTTP 状态码语义、SSE 对话协议、固定文案）或直接依赖应用代码，应留在应用内。组件只收展示型——接收 props、回传事件，不自己取数、不自己跳路由；组件之间不互相 import，共用逻辑上提 `src/composables/`。

样式与令牌契约的决策过程见 [ADR 0007](../../docs/adr/0007-component-library-style-encapsulation.md)，收录边界与写法细则见 [components-design.md](../../.trae/rules/components-design.md)。

---

## 一、组件清单

| 组件          | 职责                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageBar`     | 分页条，受控于 `page` / `pageSize` / `total`（`disabled` 可选），含上一页 / 下一页与「跳至指定页」，越界收敛到首尾页；翻页经 `update:page` 回传，重新取数由调用方负责                                                                  |
| `DataTable`   | 泛型表格（`generic="T extends object"`），列由 `ColumnSpec` 数组描述，单元格默认取同名字段、可用同名具名插槽覆盖；`selectable` 打开行选择并经 `v-model:selected-keys` 双向绑定，表头复选框只作用于当前页，已选是否跨页保留由调用方决定 |
| `SearchBar`   | 关键词输入 + 查询按钮，输入即同步 `v-model:keyword`，回车或点按钮都触发 `search`；搜索图标经 `#icon` 插槽传入，默认插槽用于放「新建」一类的页面级操作                                                                                  |
| `ModalDialog` | 弹窗骨架（遮罩、标题栏、内容插槽、底部取消与确认），点遮罩 / Esc / 右上角 × 均可关闭，`loading` 期间锁关闭；关闭图标经 `#close-icon` 插槽传入                                                                                          |
| `BatchBar`    | 批量操作条（工具栏行内联形态）：放进页面工具栏那一行，与搜索框、页面按钮同为 32px 高，选中状态切换不改变行高故不会推移下方表格；展示已选条数，动作按钮由默认插槽提供，「取消选择」图标经 `#clear-icon` 插槽传入                        |

图标一律经具名插槽由消费方传入，组件库**不自带也不依赖任何图标库**（见 [components-design.md](../../.trae/rules/components-design.md) 第 4 节）——`SearchBar` / `ModalDialog` / `BatchBar` 因此不锁死消费方的图标方案。

## 二、消费方式

跨包引用统一写 workspace 包名。接入三步：

```bash
pnpm add @mnemo/components --filter @mnemo/admin-web
```

```ts
// 1. 入口导入样式：放在哪一行都行（样式已包进 @layer，不依赖导入顺序）
import '@mnemo/components/style.css';
// 2. 具名引入，按需使用
import { PageBar } from '@mnemo/components';
```

```ts
// 或全局注册：app.use(Components) 后所有组件已在模板中可用
import Components from '@mnemo/components';

app.use(Components);
```

`package.json` 的 `exports` 声明两条入口：`"."` → `dist/index.{d.ts,mjs,cjs}`，`"./style.css"` → `dist/components.css`。`sideEffects` 保留 `**/*.css`，避免消费方打包器把样式 tree-shake 掉。

## 三、样式与令牌契约

组件库**所有**样式（含令牌默认值）都完整包在 `@layer mnemo-components { … }` 内，只用这一个层名，禁止 `!important` 与层顺序声明。CSS 级联中未分层的普通样式**恒优先于**任何分层样式，因此消费方写一条最普通的规则即可覆盖组件库，无需提高特异性、无需 `!important`、与样式导入位置无关。

覆盖的三档方式：

| 目的               | 写法                                         |
| ------------------ | -------------------------------------------- |
| 换主题色 / 尺寸    | `:root { --ui-primary: #…; }`                |
| 调单个组件         | `.ui-page-bar__button { … }`（未分层即生效） |
| 穿透 scoped 作用域 | `:deep(.ui-page-bar__input) { … }`           |

令牌默认值集中在 `src/styles/tokens.less`，形式为 `--ui-<名>: var(--<消费方同名>, <兜底值>)`——先吸附消费方同名令牌，缺失时回落兜底值，组件库因此在任何环境下都能独立渲染，同时自动跟随应用主题。要单独调组件库而不动全局时，覆盖 `--ui-*`。令牌清单见 [ADR 0007 的「令牌清单」](../../docs/adr/0007-component-library-style-encapsulation.md)。

## 四、构建与测试

- `pnpm --filter @mnemo/components run build`：`vite build`（库模式）产出 `dist/index.{mjs,cjs}`、`dist/index.d.ts` 与 `dist/components.css`；Vue 由宿主应用提供，构建时 external，不重复打包。`pnpm build` 会先构建 `packages/*` 再构建 `apps/*`，消费方无需等待手工构建。
- `pnpm --filter @mnemo/components run test`：vitest 运行纯逻辑单测，用例位于 `src/__vitest__/`（当前组件逻辑内联、尚无外提的纯逻辑，故用例为空）。
