# @repo/shared 公共能力库

跨端复用的纯逻辑工具库，供后端与桌面端共同引用。包定位与职责边界：**可跨端复用的纯逻辑放这里，应用私有逻辑留在应用内**，`apps/*` 之间禁止互相 import。

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)。

---

## 一、导出能力

包根 `src/index.ts` 只导出**不含第三方依赖**的能力，业务方从 `@repo/shared` 引入即可按需取用；依赖 `crypto-js` 的 DES 加解密单独放在 `@repo/shared/crypto`（原因见「二、按需引入」）。按模块分为四组：

| 模块               | 导出                     | 说明                                                        |
| ------------------ | ------------------------ | ----------------------------------------------------------- |
| `strings`          | `isString(value)`        | 类型守卫：判断给定值是否为字符串                            |
|                    | `capitalize(str)`        | 首字母转大写，其余字符保持不变                              |
|                    | `truncate(str, maxLen)`  | 截断到指定长度并以省略号结尾（`maxLen` 含省略号，至少为 1） |
| `common`           | `clamp(value, min, max)` | 将数值限制在 `[min, max]` 区间内                            |
|                    | `sleep(ms)`              | 延迟指定毫秒数，用于异步流程控制与简单节流                  |
| `http`             | `HTTP_STATUS`            | HTTP 状态码常量表（`as const` 对象），前后端共用的协议契约  |
|                    | `HttpStatusCode`         | 由 `HTTP_STATUS` 派生的取值联合类型                         |
| `crypto`（子路径） | `desEncrypt(plain)`      | DES 加密，返回 Base64 编码的密文                            |
|                    | `desDecrypt(cipher)`     | DES 解密；密文非法或密钥不匹配时返回空字符串                |

### DES 加密约定

`desEncrypt` / `desDecrypt` 采用 **ECB 模式 + PKCS7 填充**：同一明文每次加密结果一致，因此可直接用密文比对来校验（如密码校验），无需先解密。密钥为 8 字节 DES 分组密钥，密钥文本不足时以 0 补齐。

> DES 为可逆对称加密，仅用于按需求的存储加密；真正的生产系统应改用 bcrypt/argon2 这类加盐哈希。

当前使用方：后端 `UserStore` 用 `desEncrypt`（从 `@repo/shared/crypto` 引入）加密密码后入库，并直接比对密文完成登录校验；后端 `ConversationStore` 用 `truncate` 由首条用户消息生成会话标题。

## 二、按需引入

跨包引用统一写 workspace 包名，不用相对路径穿透到其他包。包已声明 `sideEffects: false`，并声明了 `exports` 条件导出：包根为 `types` → `dist/index.d.ts`、`import` → `dist/index.mjs`、`require` → `dist/index.cjs`；子路径 `@repo/shared/crypto` 指向 `dist/crypto.{d.ts,mjs,cjs}`。

```ts
import { truncate } from '@repo/shared';
import { desEncrypt } from '@repo/shared/crypto';
```

**为什么 DES 要另开入口。** `crypto-js` 既没有自己的 `sideEffects` 声明，又在库构建中被 external；打包器因此无法证明"导入它没有副作用"，即使一个绑定都没用到也会为保留副作用而整包引入。实测把 `crypto.ts` 放进包根时，Electron 渲染产物由 426.89 kB 涨到 641.53 kB（其中约 215 kB 是 crypto-js），且 `electron-vite` 不读 `@repo/shared` 的 `sideEffects`（同一场景下 `vite build` 能正确剔除）。

因此规则是：**包根不出现带第三方依赖的模块**。新增这类能力时照 DES 的做法另开子路径入口（`build.lib.entry` 加一项 + `exports` 加一段），而不要指望消费方的打包器替我们剔除。

依赖约定：新增第三方依赖使用 `pnpm add <包> --filter @repo/shared`；需要 postinstall 的依赖须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式登记。

## 三、构建与测试

- `pnpm --filter @repo/shared run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build`（库模式）按 `index` 与 `crypto` 两个入口产出 `dist/index.{d.ts,mjs,cjs}` 与 `dist/crypto.{d.ts,mjs,cjs}` 等文件；
- 产物保留空格与注释、开启 sourcemap，便于使用方调试；第三方运行时依赖（如 `crypto-js`）外置并保留裸包名，由使用方安装。
- `pnpm --filter @repo/shared run test`：vitest 运行单测，用例位于 `src/__vitest__/`（当前覆盖 DES 加解密与 HTTP 状态码契约）。
