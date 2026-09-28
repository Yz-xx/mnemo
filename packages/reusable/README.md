# @repo/reusable 业务可复用库

跨端复用的**业务可复用代码**库，供后端与桌面端共同引用。包定位与职责边界：判据是「**是否与业务约定绑定**」，而不是「是否可复用」——换一个业务它还用得上吗？用不上，是因为它把本业务约定编码了进去（HTTP 状态码裁剪、SSE 对话协议、必须一字不差的固定文案），这类代码放这里；纯粹的通用算法与工具放 `@repo/shared`；只服务单端的代码留在应用内。`apps/*` 之间禁止互相 import。

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)；与业务无关的通用工具见 [@repo/shared](../shared/README.md)。

---

## 一、导出能力

包为单入口 `src/index.ts`，无第三方依赖，业务方从 `@repo/reusable` 引入即可按需取用。按模块分为三组：

| 模块       | 导出                                  | 说明                                                                   |
| ---------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `http`     | `HTTP_STATUS`                         | HTTP 状态码常量表（`as const` 对象），前后端共用的协议契约（七项取值） |
|            | `HttpStatusCode`                      | 由 `HTTP_STATUS` 派生的取值联合类型                                    |
|            | `toHttpStatusCode(v)`                 | 边界收窄：契约外的状态码回落为 500，供调用方安全地按码分支             |
| `chat`     | `AgentStreamEvent`、`ChatStreamEvent` | SSE 对话流的事件类型（纯类型，不产生运行时代码）                       |
| `messages` | `SESSION_EXPIRED_MESSAGE`             | 登录失效固定文案：服务端 401 与桌面端登录页共用同一句话                |

当前使用方：后端各路由与中间件统一取 `HTTP_STATUS`，`auth/middleware.ts` 与 `messages.ts` 取 `SESSION_EXPIRED_MESSAGE`，`ChatStreamEvent` 是后端 SSE 推送与桌面端事件消费共用的声明；桌面端的渲染进程由 `api/client.ts` 统一引入 `HTTP_STATUS` / `toHttpStatusCode` / `HttpStatusCode` / `ChatStreamEvent` / `SESSION_EXPIRED_MESSAGE` 并转发给其余模块，它是渲染进程**唯一同时依赖本包与 `@repo/shared` 的模块**。契约说明见 [ADR 0001](../../docs/adr/0001-http-status-contract.md)。

## 二、按需引入

跨包引用统一写 workspace 包名，不用相对路径穿透到其他包。包已声明 `sideEffects: false`，并声明了 `exports` 条件导出：包根为 `types` → `dist/index.d.ts`、`import` → `dist/index.mjs`、`require` → `dist/index.cjs`。

```ts
import type { ChatStreamEvent } from '@repo/reusable';
import { HTTP_STATUS, toHttpStatusCode } from '@repo/reusable';
```

**依赖方向。** `@repo/reusable` 可以依赖 `@repo/shared`（通用工具不认识业务约定，单向才成立）；`@repo/shared` 不得反向依赖本包，否则通用工具会被业务概念污染。当前本包为零依赖。规则同样要求**包根不出现带第三方依赖的模块**：第三方包常无自己的 `sideEffects` 声明，打包器无法证明「导入它无副作用」，即使一个绑定都没用到也会为保留副作用而整包引入。理由与实测数据与 `@repo/shared` 的 DES 段落同源，详见 [packages/shared/README.md 的「二、按需引入」](../shared/README.md)。将来若引入带第三方依赖的业务能力，照 `@repo/shared/crypto` 的做法另开子路径入口（`build.lib.entry` 加一项 + `exports` 加一段），不要指望消费方的打包器替我们剔除。

依赖约定：新增第三方依赖使用 `pnpm add <包> --filter @repo/reusable`；需要 postinstall 的依赖须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式登记。

## 三、构建与测试

- `pnpm --filter @repo/reusable run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build`（库模式，**单入口**）产出 `dist/index.{d.ts,mjs,cjs}` 等文件，声明文件由 `vite-plugin-dts` 依 `tsconfig.json` 的 include / exclude 生成（测试目录不参与产物）；
- 产物保留空格与注释、开启 sourcemap，便于使用方调试；当前无第三方运行时依赖，无需 external 配置。
- `pnpm --filter @repo/reusable run test`：vitest 运行单测，用例位于 `src/__vitest__/`（当前覆盖 HTTP 状态码契约 4 项）。
