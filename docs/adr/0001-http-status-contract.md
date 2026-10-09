# HTTP 状态码契约收敛为七项，并放入 @repo/shared

后端签发状态码、桌面端按状态码分支（401 触发重新登录、204 表示无响应体），同一份取值手抄两遍正是漏改的源头，因此把它放进跨端共享包 `@repo/shared`（`HTTP_STATUS`），且只保留 200 / 201 / 204 / 400 / 401 / 404 / 500 七项。用 `as const` 对象而非 TS `enum`：仓库既有的类型风格是字面量联合（`LogLevel`、`KnowledgeScope`），对象不产生运行时枚举开销，取值集合还能由常量派生（`HttpStatusCode`）。

## Considered Options

- **各端各写一份常量**：`agent-client` 此前不依赖任何 `@repo/*` 包，为七个数字引入 workspace 依赖看起来不划算。否决理由：客户端的 401 分支与后端的签发逻辑必须同时改，分开写只是把一次修改变成两次。
- **只放后端（`config.ts` 或新建 `constants.ts`）**：客户端拿不到，等于回到上一项。
- **TS `enum`**：能表达"取值是一个闭合集合"的意图，但仓库无先例，且会产出运行时代码；`as const` 对象加派生类型足以达到同样的类型安全。

## Consequences

- 用到状态码的地方一律写 `HTTP_STATUS.XXX`，不再出现字面量数字；新增状态码必须先改 `backend-design.md` 第 3 章，再改 `shared/src/http.ts`。
- 三处刻意偏离"常识默认"，未来不要顺手"修正"：
  - 权限不足返回 `404` 而非 `403`（backend-design 第 4 章：不泄漏他人资源的存在）。
  - 用户名冲突返回 `400` 而非 `409`。
  - 知识库入库失败返回 `500` 而非 `502`：5xx 对外只有一个状态码，具体原因写在响应文案里。
- 状态码本身走包根（`import { HTTP_STATUS } from '@repo/shared'`），`agent-client` 因此新增了对 `@repo/shared` 的依赖。执行中实测到一个陷阱：包根一旦 re-export `crypto.ts`，Electron 渲染产物就会多出约 215 kB 的 crypto-js（426.89 kB → 641.53 kB）；`vite build` 能剔除而 `electron-vite` 不能，因为后者不读本包的 `sideEffects`。最终做法是把 DES 拆到 `@repo/shared/crypto`、包根只留无第三方依赖的模块，并给包声明 `sideEffects: false`。约束记在 `skills-overview.md` 与 `packages/shared/README.md`：**包根不出现带第三方依赖的模块**。

## 后续变更

后续做了包拆分：`@repo/shared` 收敛为只放**与业务无关的通用工具**（strings / common / crypto），与业务约定绑定的可复用代码另建 `@repo/reusable` 承载。`HTTP_STATUS` / `toHttpStatusCode` / `HttpStatusCode` 因此从 `@repo/shared` 迁到 `@repo/reusable`（其测试也迁至 `packages/reusable/src/__vitest__/http.test.ts`）。

本文记录的决策内容本身不变——契约仍收敛为这七项、仍放在一个跨端共享包里——仅承载位置从 `@repo/shared` 变为 `@repo/reusable`；上文出现的 `shared/src/http.ts` 与 `import { HTTP_STATUS } from '@repo/shared'` 等表述按此理解。

契约随后**由七项增补为八项**：新增 `HTTP_STATUS.SERVICE_UNAVAILABLE`（`503`），依据与完整方案见 [ADR 0010](0010-concurrency-governance.md)。增补的理由正是与本篇取舍正面冲突的那一点——「5xx 对外只有一个」把**可重试的临时态**（过载）与**真错误**压成了同一个码，客户端无从决定是否退避重试，因此为过载单开一项，并约定它**只由并发闸门在硬水位处签发**、响应固定附 `Retry-After`。本篇其余结论仍然有效：依赖失败（含知识库入库失败）依旧 `500`，权限不足依旧 `404`，用户名冲突依旧 `400`；标题中的「七项」指增补前的规模。
