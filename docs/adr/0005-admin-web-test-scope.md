# admin-web 只对纯逻辑补单测，不引入组件测试依赖

后台管理网站（`apps/admin-web`）在本次补测前是零测试：全仓 27 个测试文件里 21 个在 `agent-server`、6 个在 `packages/*`，两个前端应用一个用例都没有。本次为它补测，范围**只取纯逻辑**，不为测 `.vue` 组件引入任何测试依赖。

选中的接缝是四处，全部满足「不连网络、不碰 DOM 就能验完」：

| 接缝                          | 钉住的行为                                                                 | 需要的替身               |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------ |
| `composables/usePagedList.ts` | 翻页竞态（只认最后一次请求）、失败文案回落、搜索归回首页                   | 无                       |
| `stores/auth.ts`              | 非管理员登录当场拒绝且不落令牌、`/me` 并发复用同一在途请求、登出失败仍清态 | pinia + localStorage     |
| `api/client.ts`               | 令牌读写三件套、401 清令牌并通知失效、500 不动登录态                       | localStorage + fetch     |
| `router/guards.ts`            | 登录页放行、无令牌带 redirect 回登录、**先拉 `/me` 再判角色**              | 伪 router + pinia + 存储 |

判据来自 `code-style.md` 第 6 章：「只测纯逻辑与边界，外部依赖用替身隔离」。四处里唯一涉及跨模块组合的是 `api/client` 的 401 收口，它用真实 `Response` 顶替 `fetch`，验的是「错误归一化 → 清令牌 → 通知失效」这条端到端路径。

## Considered Options

- **引入 `@vue/test-utils` + `happy-dom` 测组件**：否决。两个新依赖只为验模板分支与按钮禁用态，而这类断言与 DOM 结构、类名强耦合，改样式就红；仓库既有口径是组件层由 `vue-tsc` 类型检查加实机走查兜底。
- **引入 `happy-dom` 只为提供 `localStorage`**：否决。三个模块需要的只是「有个地方存字符串」，`src/__vitest__/storageStub.ts` 用内存 Map 顶替即可，不必为此换掉整个运行环境。
- **继续不补测试**：否决。这四处都是踩过坑的地方——守卫「先拉 `/me` 再判角色」是刷新页面误踢管理员的根因，401 收口决定令牌失效后能否回到登录页；只靠实机走查，这类回归没有任何拦截点。
- **连同 `@repo/reusable` 的 `createApiClient` 一起补**：暂不做。那是工厂自身的接缝、属 `packages/reusable` 的测试范围，本包只验自己注入的 `getToken` 与 `onUnauthorized` 行为，避免一次改动横跨两包。

## Consequences

- `.vue` 组件的模板分支、禁用态、空列表文案仍无自动化护栏，只能靠 `vue-tsc` 与实机走查——这是本决策已知且接受的成本。日后若组件内逻辑复杂度上升（例如出现值得单测的状态机），应先把逻辑外提到 composable 再测，而不是回头给组件补 DOM 测试。
- 测试运行在 node 环境（vitest 默认值，不改 `environment`），`localStorage` 与 `fetch` 由 `vi.stubGlobal` 顶替，因此本包不需要 `happy-dom` / `jsdom`。
- `apps/admin-web` 新增 `test: vitest run` 接入根 `pnpm test`（`scripts/test.js` 执行的是 `pnpm -r run test`，没有该脚本的包会被自动跳过）；vitest 本体由根 `package.json` 提供，本包不重复声明。
- `apps/admin-web/tsconfig.json` 的 `exclude` 增加 `src/__vitest__`（与 `agent-server` 同款）：测试文件由 vitest 直接运行，不进 `vue-tsc --noEmit` 与构建产物。
