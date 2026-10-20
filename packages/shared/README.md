# @mnemo/shared 通用工具库

跨端复用的**通用工具库**，供后端与桌面端共同引用。包定位与职责边界：**只放与业务无关的通用能力**——判据是「换一个业务它还用得上吗」，用不上就说明它绑定了本业务约定（状态码裁剪、对话协议、固定文案），应放 [@mnemo/reusable](../reusable/README.md)；应用私有逻辑留在应用内。`apps/*` 之间禁止互相 import。

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)。

---

## 一、导出能力

包根 `src/index.ts` 只导出**不含第三方依赖**的能力，业务方从 `@mnemo/shared` 引入即可按需取用。按模块分为五组：

| 模块      | 导出                         | 说明                                                                                                           |
| --------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `strings` | `isString(value)`            | 类型守卫：判断给定值是否为字符串                                                                               |
|           | `capitalize(str)`            | 首字母转大写，其余字符保持不变                                                                                 |
|           | `truncate(str, maxLen)`      | 截断到指定长度并以省略号结尾（`maxLen` 含省略号，至少为 1）                                                    |
| `common`  | `clamp(value, min, max)`     | 将数值限制在 `[min, max]` 区间内                                                                               |
|           | `sleep(ms)`                  | 延迟指定毫秒数，用于异步流程控制与简单节流                                                                     |
|           | `toErrorMessage(error)`      | 提取错误消息：非 Error 抛出值转为字符串，两端共用同一降级口径                                                  |
| `bytes`   | `toBase64(bytes)`            | 字节序列转 Base64：先按字节还原二进制字符串再 `btoa`，供跨端编码密文                                           |
|           | `formatBytes(bytes)`         | 字节容量转可读文本（B / KB / MB / GB 四档，非字节档保留一位小数）                                              |
| `time`    | `formatTime(iso)`            | UTC ISO 串按本地时区展示；解析失败回落为「—」                                                                  |
|           | `formatDate(date)`           | `Date` 转本地日期 `YYYY-MM-DD`（不走 `toISOString`，避免跨时区偏移）                                           |
| `http`    | `createHttpClient(options?)` | 创建类 axios 客户端：方法别名、`params` / 请求体序列化、超时、拦截器、错误归一化；只用内置 `fetch`，故仍在包根 |
|           | `HttpError` / `isHttpError`  | 请求错误与类型守卫，`code` 区分 HTTP / 超时 / 网络 / 取消 / 解析五类                                           |

### HTTP 客户端

`createHttpClient` 是零第三方依赖的类 axios 客户端：只用运行时内置的 `fetch` / `Headers` / `FormData` / `Response` / `ReadableStream`，因此仍在包根导出。能力边界与取舍见 [ADR 0013](../../docs/adr/0013-shared-http-client-via-fetch.md)。

#### 1. 创建实例

```ts
import { createHttpClient, isHttpError } from '@mnemo/shared';

const api = createHttpClient({
  baseURL: '/api', // 也可传 () => runtime.baseURL：运行期换地址不必重建实例
  headers: { 'X-Client': 'admin-web' },
  timeoutMs: 15_000, // 0 或省略表示不超时
  getToken: () => localStorage.getItem('token'), // 鉴权唯一入口，非空时自动补 Authorization: Bearer
});
```

实例不持有「发出请求时的状态」：token 每次请求实时取，`baseURL` 可取函数。因此地址或登录态变化都不需要重建实例，可以当模块级单例长期持有。

#### 2. 发请求

```ts
interface User {
  id: number;
  username: string;
}

// 第二个参数是单次配置；params 自动拼查询串（数组按重复键展开）
const users = await api.get<User[]>('/users', { params: { page: 1, tag: ['a', 'b'] } });
// → GET /api/users?page=1&tag=a&tag=b

// 普通对象自动 JSON.stringify 并补 Content-Type
await api.post('/users', { username: 'tom' });

// FormData 原样透传，且不补 Content-Type（multipart boundary 必须由运行时生成）
const form = new FormData();
form.append('file', file);
await api.post('/files', form);

// 需要 status / headers / raw 时取完整响应
const response = await api.requestRaw<User>('/users/1');
(response.status, response.headers.get('etag'), response.raw);
```

别名：`get` / `delete` / `head` / `options` 签名为 `(url, config?)`，`post` / `put` / `patch` 为 `(url, body?, config?)`；通用入口是 `request`（完整配置对象）与 `requestRaw`（恒返回完整响应）。

单次配置项（`HttpMethodConfig`）：

| 字段                 | 说明                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| `params`             | 查询参数；`undefined` / `null` 跳过该键，数组按重复键展开                   |
| `headers`            | 单次请求头，覆盖实例默认头；`Content-Type` / `Authorization` 已存在则不覆盖 |
| `baseURL`            | 覆盖实例默认地址                                                            |
| `body`               | 请求体（别名方法由第二参给出）                                              |
| `responseType`       | `json`（默认）/ `text` / `blob` / `arrayBuffer` / `stream` / `none`         |
| `timeoutMs`          | 超时毫秒数，`0` 表示不超时                                                  |
| `signal`             | 外部 `AbortSignal`，用于主动取消                                            |
| `returnFullResponse` | `true` 时返回完整响应（等价于改用 `requestRaw`）                            |

请求体口径：普通对象 → `JSON.stringify` + `application/json`；`string` / `URLSearchParams` / `FormData` / `Blob` / `ArrayBuffer` / TypedArray / `ReadableStream` 原样透传（不补 `Content-Type`）；数字、布尔等原始值按字符串发送。

#### 3. 响应解析

- **默认返回 `data`**：`client.get<T>('/users')` 直接给出解析后的响应体，与既有 `request<T>` 的消费方形状一致。
- **完整响应**用 `requestRaw` 或 `returnFullResponse: true`（`HttpResponse`：`data` / `status` / `headers` / `raw`）。`raw` 是逃生口——客户端没封装的能力（如自行读响应体流）直接用原生 `Response`。
- **`204` 与 `responseType: 'none'` 返回 `undefined`**；JSON 走 `text()` 再 `JSON.parse`，故 200 但空响应体同样得到 `undefined`。
- **`stream` 原样交出未消费的 `ReadableStream`**：分帧（如 SSE 的 `data:` 行）属消费方协议，通用库不替业务决定一段流该怎么读。
- `status` 保留原始数字，客户端不做契约收敛——把契约外的码归到哪一档属业务口径。

#### 4. 错误处理

失败一律抛 `HttpError`（用 `isHttpError(error)` 判别），`code` 分五类：

| `code`          | 触发时机                             | `status`   |
| --------------- | ------------------------------------ | ---------- |
| `HTTP_ERROR`    | 响应非 2xx（含 `stream` 时无响应体） | 原始状态码 |
| `TIMEOUT`       | 超过 `timeoutMs`                     | `0`        |
| `NETWORK_ERROR` | 网络失败等传输异常                   | `0`        |
| `ABORTED`       | 外部 `signal` 主动取消               | `0`        |
| `PARSE_ERROR`   | 响应体不是合法 JSON（`data` 留原文） | 原始状态码 |

`message` 优先取服务端错误体的 `message`，取不到退化为 `请求失败（HTTP ${status}）`；`data` 是尽力解析出的错误体，`cause` 保留原始错误便于追根因。

```ts
try {
  await api.get('/users/1');
} catch (error) {
  if (!isHttpError(error)) throw error;
  if (error.code === 'TIMEOUT') return notifyTimeout();
  if (error.status === 401) return redirectToLogin();
  notify(error.message); // 服务端文案已可直接展示
}
```

#### 5. 拦截器

`request` / `response` / `error` 三个钩子：`use(handler)` 注册并返回 id，`eject(id)` 按 id 移除（id 不存在时静默忽略）。

- **请求拦截器后注册者先执行**（离发送最近，与 axios 同口径）；`response` / `error` 按注册顺序执行。注册方向与执行方向分开，执行顺序只有一个真相来源。
- 请求拦截器拿到的是**已合并实例默认值**的配置，可继续改写：`baseURL` 等字段被改回 `undefined` 时，发送前会再兜一次默认。
- **`error` 返回一个 `HttpResponse` 即视为「已恢复」**，该响应成为本次请求结果；返回 `HttpError` 则换成它继续沿链抛。刻意不允许返回任意值，否则「结果」与「错误」在类型上无法区分。

```ts
api.interceptors.request.use((config) => ({
  ...config,
  headers: { ...config.headers, 'X-Trace': traceId() },
}));

// 401 的业务口径收在一处，调用点不必各自判断
api.interceptors.error.use((error) => {
  if (error.status === 401) redirectToLogin();
  return error;
});
```

#### 6. 超时与取消

超时用 `timeoutMs`（实例默认 + 单次覆盖），取消用标准 `AbortSignal`。两者最终都表现为 `AbortError`，客户端靠信号来源归因，故 `TIMEOUT` 与 `ABORTED` 不会混淆：

```ts
const controller = new AbortController();
api.get('/long-task', { signal: controller.signal, timeoutMs: 5_000 });
controller.abort(); // → HttpError { code: 'ABORTED' }
```

超时信号覆盖「发送 + 读响应体」整段：慢响应体同样受超时约束，定时器在请求结束（含解析完）后才释放。

#### 7. 运行期改写默认项

`defaults` 可写，改完对后续请求立即生效，无需重建实例：

```ts
api.defaults.timeoutMs = 30_000;
api.defaults.headers['X-Client'] = 'desktop';
```

#### 8. 刻意不做的能力

别当漏做：上传 / 下载进度（`fetch` 无对应 API）、cancel token（用 `AbortSignal`）、transform 管道（与拦截器重叠）、自动重试（可重试的 503 属业务契约）、XSRF 自动处理（本仓同源 + Bearer）。测试用 `HttpClientOptions.fetch` 注入替身走同一接缝，不必 mock 全局。

当前使用方：后端 `ConversationStore` 用 `truncate` 由首条用户消息生成会话标题，`llm/tools/files.ts` 用 `formatBytes` 生成附件体积描述，`conversation/store/stats.ts` 用 `formatDate` 归档统计日期，`errors.ts` 与桌面端（经 `api/client.ts` 转发）统一调用 `toErrorMessage`。管理网站与桌面端的时间 / 体积展示统一取 `formatTime` / `formatBytes`。HTTP 状态码契约（`HTTP_STATUS`）、SSE 对话事件类型（`ChatStreamEvent`）、口令加密（`encryptPassword`）与登录失效固定文案（`SESSION_EXPIRED_MESSAGE`）已随业务约定迁至 [@mnemo/reusable](../reusable/README.md)，不再由本包提供。HTTP 客户端（`createHttpClient`）已由管理网站（`src/api/client.ts`，401 收口挂在错误拦截器上）与桌面端（`api/client.ts`，附件下载走 `responseType: 'blob'`、对话流走 `responseType: 'stream'`）接入，`@mnemo/reusable` 原有的 `createApiClient` 工厂随之删除，取舍见 [ADR 0013](../../docs/adr/0013-shared-http-client-via-fetch.md)。

## 二、按需引入

跨包引用统一写 workspace 包名，不用相对路径穿透到其他包。包已声明 `sideEffects: false`，并声明了 `exports` 条件导出：包根为 `types` → `dist/index.d.ts`、`import` → `dist/index.mjs`、`require` → `dist/index.cjs`。

```ts
import { truncate } from '@mnemo/shared';
```

**包根不出现带第三方依赖的模块。** 第三方包常常没有自己的 `sideEffects` 声明，打包器因此无法证明「导入它没有副作用」，即使一个绑定都没用到也会为保留副作用而整包引入；而 `electron-vite` 不读本包的 `sideEffects`（同一场景下 `vite build` 能正确剔除）。本包历史上为口令存储提供过 DES 加解密（依赖 `crypto-js`），正是为此单开过 `@mnemo/shared/crypto` 子路径入口；该能力已随存量口令迁移完成一并移除，取舍见 [ADR 0004](../../docs/adr/0004-password-transport-and-storage.md) 与 [ADR 0001](../../docs/adr/0001-http-status-contract.md)。将来若引入带第三方依赖的能力，仍照此另开子路径入口（`build.lib.entry` 加一项 + `exports` 加一段），不要指望消费方的打包器替我们剔除。

依赖约定：新增第三方依赖使用 `pnpm add <包> --filter @mnemo/shared`；需要 postinstall 的依赖须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式登记。

## 三、构建与测试

- `pnpm --filter @mnemo/shared run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build`（库模式）产出 `dist/index.{d.ts,mjs,cjs}`，声明文件由 `vite-plugin-dts` 依 `tsconfig.json` 的 include / exclude 生成（测试目录不参与产物）；
- 产物保留空格与注释、开启 sourcemap，便于使用方调试。
- `pnpm --filter @mnemo/shared run test`：vitest 运行单测，用例位于 `src/__vitest__/`（当前覆盖错误消息提取、Base64 编码与容量分档、时间格式化与非法值回落，以及 HTTP 客户端的地址拼装 / 序列化 / 错误归一化 / 超时与取消 / 拦截器链）。
