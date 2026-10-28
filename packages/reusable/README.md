# @mnemo/reusable 业务可复用库

跨端复用的**业务可复用代码**库，供后端与桌面端共同引用。包定位与职责边界：判据是「**是否与业务约定绑定**」，而不是「是否可复用」——换一个业务它还用得上吗？用不上，是因为它把本业务约定编码了进去（HTTP 状态码裁剪、SSE 对话协议、必须一字不差的固定文案），这类代码放这里；纯粹的通用算法与工具放 `@mnemo/shared`；只服务单端的代码留在应用内。`apps/*` 之间禁止互相 import。

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)；与业务无关的通用工具见 [@mnemo/shared](../shared/README.md)。

---

## 一、导出能力

包为单入口 `src/index.ts`，业务方从 `@mnemo/reusable` 引入即可按需取用。按模块分组：

| 模块       | 导出                                                     | 说明                                                                                                          |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `http`     | `HTTP_STATUS`                                            | HTTP 状态码常量表（`as const` 对象），前后端共用的协议契约（八项取值，含过载拒绝 503）                        |
|            | `HttpStatusCode`                                         | 由 `HTTP_STATUS` 派生的取值联合类型                                                                           |
|            | `toHttpStatusCode(v)`                                    | 边界收窄：契约外的状态码回落为 500，供调用方安全地按码分支                                                    |
| `chat`     | `AgentStreamEvent`、`ChatStreamEvent`、`ChatStreamFrame` | SSE 对话流的事件类型，以及「事件 + 服务端分配的序号」组成的一帧（纯类型，不产生运行时代码）                   |
| `sse`      | `parseSSEStream(stream)`                                 | 把 SSE 响应体流按空行分帧、读 `id:` 行取序号，产出 `ChatStreamFrame`；旧服务端不下发 `id:` 时退回本地递增序号 |
| `errors`   | `isUnauthorized(error)`                                  | 登录失效判定：错误经契约收敛后为 401 才算失效                                                                 |
| `messages` | `SESSION_EXPIRED_MESSAGE`                                | 登录失效固定文案：服务端 401 与桌面端登录页共用同一句话                                                       |
| `password` | `encryptPassword(api, plain)`                            | 取服务端公钥（RSA-OAEP）加密口令并返回 Base64 密文                                                            |

当前使用方：后端各路由与中间件统一取 `HTTP_STATUS`，`auth/middleware.ts` 与 `messages.ts` 取 `SESSION_EXPIRED_MESSAGE`，`ChatStreamEvent` / `ChatStreamFrame` 是后端 SSE 推送与桌面端事件消费共用的声明——序号由服务端 `eventStream` 的 `send` 写进 `id:` 行，桌面端以帧序号记录断点、重连时上报 `lastEventId`。**HTTP 请求本身不再由本包承担**：请求头拼装、错误归一化、超时与流式发送都是与业务无关的通用能力，已迁至 [@mnemo/shared](../shared/README.md) 的 `createHttpClient`（取舍见 [ADR 0013](../../docs/adr/0013-shared-http-client-via-fetch.md)），管理网站与桌面端各建一个实例、注入 `baseURL` 与 `getToken`，401 收口从工厂回调改挂在错误拦截器上，靠本包的 `isUnauthorized` 保持「契约外的码按 500、不算失效」的口径；SSE 的分帧与序号解析由本包的 `parseSSEStream` 消费通用客户端交出的字节流；对话协议里 `source` 事件承担过程中的增量出处、`sources` 事件承担流末尾的终局来源清单（口径见 [ADR 0017](../../docs/adr/0017-knowledge-source-attribution.md)）。桌面端的渲染进程由 `api/client.ts` 统一引入本包与 `@mnemo/shared` 的能力并转发给其余模块，它是渲染进程**唯一同时依赖这两个包的模块**；`encryptPassword` 被桌面端（登录、注册）与管理网站的两处（登录、新建用户）取用。契约说明见 [ADR 0001](../../docs/adr/0001-http-status-contract.md)，口令传输与存储见 [ADR 0004](../../docs/adr/0004-password-transport-and-storage.md)，断点续传协议见 [ADR 0015](../../docs/adr/0015-sse-resumable-stream.md)。

## 二、按需引入

跨包引用统一写 workspace 包名，不用相对路径穿透到其他包。包已声明 `sideEffects: false`，并声明了 `exports` 条件导出：包根为 `types` → `dist/index.d.ts`、`import` → `dist/index.mjs`、`require` → `dist/index.cjs`。

```ts
import type { ChatStreamEvent, ChatStreamFrame } from '@mnemo/reusable';
import { HTTP_STATUS, toHttpStatusCode } from '@mnemo/reusable';
```

**依赖方向。** `@mnemo/reusable` 可以依赖 `@mnemo/shared`（通用工具不认识业务约定，单向才成立）；`@mnemo/shared` 不得反向依赖本包，否则通用工具会被业务概念污染。本包当前唯一的跨包依赖正是 `@mnemo/shared`（`encryptPassword` 用它把密文字节转成 Base64），无第三方运行时依赖。规则同样要求**包根不出现带第三方依赖的模块**：第三方包常无自己的 `sideEffects` 声明，打包器无法证明「导入它无副作用」，即使一个绑定都没用到也会为保留副作用而整包引入。理由与取舍详见 [packages/shared/README.md 的「二、按需引入」](../shared/README.md)。将来若引入带第三方依赖的业务能力，照该处的做法另开子路径入口（`build.lib.entry` 加一项 + `exports` 加一段），不要指望消费方的打包器替我们剔除。

依赖约定：新增第三方依赖使用 `pnpm add <包> --filter @mnemo/reusable`；需要 postinstall 的依赖须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式登记。

## 三、构建与测试

- `pnpm --filter @mnemo/reusable run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build`（库模式，**单入口**）产出 `dist/index.{d.ts,mjs,cjs}` 等文件，声明文件由 `vite-plugin-dts` 依 `tsconfig.json` 的 include / exclude 生成（测试目录不参与产物）；
- 产物保留空格与注释、开启 sourcemap，便于使用方调试；跨包依赖（`@mnemo/shared`）由构建配置按 `package.json` 的 `dependencies` 统一 external 并保留裸包名——使用方本就直连 shared，内联会把同一份通用工具在产物里存两遍。
- `pnpm --filter @mnemo/reusable run test`：vitest 运行单测，用例位于 `src/__vitest__/`（当前覆盖 HTTP 状态码契约 5 项、`isUnauthorized` 的契约收敛 4 项、`parseSSEStream` 的分帧、序号解析与截断 6 项）。
