# @repo/shared 通用工具库

跨端复用的**通用工具库**，供后端与桌面端共同引用。包定位与职责边界：**只放与业务无关的通用能力**——判据是「换一个业务它还用得上吗」，用不上就说明它绑定了本业务约定（状态码裁剪、对话协议、固定文案），应放 [@repo/reusable](../reusable/README.md)；应用私有逻辑留在应用内。`apps/*` 之间禁止互相 import。

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)。

---

## 一、导出能力

包根 `src/index.ts` 只导出**不含第三方依赖**的能力，业务方从 `@repo/shared` 引入即可按需取用。按模块分为四组：

| 模块      | 导出                     | 说明                                                                 |
| --------- | ------------------------ | -------------------------------------------------------------------- |
| `strings` | `isString(value)`        | 类型守卫：判断给定值是否为字符串                                     |
|           | `capitalize(str)`        | 首字母转大写，其余字符保持不变                                       |
|           | `truncate(str, maxLen)`  | 截断到指定长度并以省略号结尾（`maxLen` 含省略号，至少为 1）          |
| `common`  | `clamp(value, min, max)` | 将数值限制在 `[min, max]` 区间内                                     |
|           | `sleep(ms)`              | 延迟指定毫秒数，用于异步流程控制与简单节流                           |
|           | `toErrorMessage(error)`  | 提取错误消息：非 Error 抛出值转为字符串，两端共用同一降级口径        |
| `bytes`   | `toBase64(bytes)`        | 字节序列转 Base64：先按字节还原二进制字符串再 `btoa`，供跨端编码密文 |
|           | `formatBytes(bytes)`     | 字节容量转可读文本（B / KB / MB / GB 四档，非字节档保留一位小数）    |
| `time`    | `formatTime(iso)`        | UTC ISO 串按本地时区展示；解析失败回落为「—」                        |
|           | `formatDate(date)`       | `Date` 转本地日期 `YYYY-MM-DD`（不走 `toISOString`，避免跨时区偏移） |

当前使用方：后端 `ConversationStore` 用 `truncate` 由首条用户消息生成会话标题，`llm/tools/files.ts` 用 `formatBytes` 生成附件体积描述，`conversation/store/stats.ts` 用 `formatDate` 归档统计日期，`errors.ts` 与桌面端（经 `api/client.ts` 转发）统一调用 `toErrorMessage`。管理网站与桌面端的时间 / 体积展示统一取 `formatTime` / `formatBytes`。HTTP 状态码契约（`HTTP_STATUS`）、SSE 对话事件类型（`ChatStreamEvent`）、口令加密（`encryptPassword`）与登录失效固定文案（`SESSION_EXPIRED_MESSAGE`）已随业务约定迁至 [@repo/reusable](../reusable/README.md)，不再由本包提供。

## 二、按需引入

跨包引用统一写 workspace 包名，不用相对路径穿透到其他包。包已声明 `sideEffects: false`，并声明了 `exports` 条件导出：包根为 `types` → `dist/index.d.ts`、`import` → `dist/index.mjs`、`require` → `dist/index.cjs`。

```ts
import { truncate } from '@repo/shared';
```

**包根不出现带第三方依赖的模块。** 第三方包常常没有自己的 `sideEffects` 声明，打包器因此无法证明「导入它没有副作用」，即使一个绑定都没用到也会为保留副作用而整包引入；而 `electron-vite` 不读本包的 `sideEffects`（同一场景下 `vite build` 能正确剔除）。本包历史上为口令存储提供过 DES 加解密（依赖 `crypto-js`），正是为此单开过 `@repo/shared/crypto` 子路径入口；该能力已随存量口令迁移完成一并移除，取舍见 [ADR 0004](../../docs/adr/0004-password-transport-and-storage.md) 与 [ADR 0001](../../docs/adr/0001-http-status-contract.md)。将来若引入带第三方依赖的能力，仍照此另开子路径入口（`build.lib.entry` 加一项 + `exports` 加一段），不要指望消费方的打包器替我们剔除。

依赖约定：新增第三方依赖使用 `pnpm add <包> --filter @repo/shared`；需要 postinstall 的依赖须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式登记。

## 三、构建与测试

- `pnpm --filter @repo/shared run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build`（库模式）产出 `dist/index.{d.ts,mjs,cjs}`，声明文件由 `vite-plugin-dts` 依 `tsconfig.json` 的 include / exclude 生成（测试目录不参与产物）；
- 产物保留空格与注释、开启 sourcemap，便于使用方调试。
- `pnpm --filter @repo/shared run test`：vitest 运行单测，用例位于 `src/__vitest__/`（当前覆盖错误消息提取、Base64 编码与容量分档、时间格式化与非法值回落）。
