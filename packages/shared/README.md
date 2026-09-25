# @repo/shared 公共能力库

跨端复用的纯逻辑工具库，供后端与桌面端共同引用。包定位与职责边界：**可跨端复用的纯逻辑放这里，应用私有逻辑留在应用内**，`apps/*` 之间禁止互相 import。

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)。

---

## 一、导出能力

统一出口为 `src/index.ts`，业务方只需从 `@repo/shared` 引入。按模块分为三组：

| 模块      | 导出                     | 说明                                                        |
| --------- | ------------------------ | ----------------------------------------------------------- |
| `strings` | `isString(value)`        | 类型守卫：判断给定值是否为字符串                            |
|           | `capitalize(str)`        | 首字母转大写，其余字符保持不变                              |
|           | `truncate(str, maxLen)`  | 截断到指定长度并以省略号结尾（`maxLen` 含省略号，至少为 1） |
| `common`  | `clamp(value, min, max)` | 将数值限制在 `[min, max]` 区间内                            |
|           | `sleep(ms)`              | 延迟指定毫秒数，用于异步流程控制与简单节流                  |
| `crypto`  | `desEncrypt(plain)`      | DES 加密，返回 Base64 编码的密文                            |
|           | `desDecrypt(cipher)`     | DES 解密；密文非法或密钥不匹配时返回空字符串                |

### DES 加密约定

`desEncrypt` / `desDecrypt` 采用 **ECB 模式 + PKCS7 填充**：同一明文每次加密结果一致，因此可直接用密文比对来校验（如密码校验），无需先解密。密钥为 8 字节 DES 分组密钥，密钥文本不足时以 0 补齐。

> DES 为可逆对称加密，仅用于按需求的存储加密；真正的生产系统应改用 bcrypt/argon2 这类加盐哈希。

当前使用方：后端 `UserStore` 用 `desEncrypt` 加密密码后入库，并直接比对密文完成登录校验；后端 `ConversationStore` 用 `truncate` 由首条用户消息生成会话标题。

## 二、引用方式

跨包引用统一写 workspace 包名，不用相对路径穿透到其他包：

```ts
import { desEncrypt, truncate } from '@repo/shared';
```

包已声明 `exports` 条件导出：`types` → `dist/index.d.ts`、`import` → `dist/index.mjs`、`require` → `dist/index.cjs`。

依赖约定：新增第三方依赖使用 `pnpm add <包> --filter @repo/shared`；需要 postinstall 的依赖须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式登记。

## 三、构建与测试

- `pnpm --filter @repo/shared run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build`（库模式）产出 `dist/index.mjs`、`dist/index.cjs` 与 `dist/index.d.ts` 等类型声明；
- 产物保留空格与注释、开启 sourcemap，便于使用方调试；第三方运行时依赖（如 `crypto-js`）外置并保留裸包名，由使用方安装。
- `pnpm --filter @repo/shared run test`：vitest 运行单测，用例位于 `src/__vitest__/`（当前覆盖 DES 加解密）。
