---
description: apps/desktop（Electron + Vue 3）的设计规范，涵盖三层结构与边界、主进程职责拆分、IPC 契约、主题与防闪烁处理、渲染进程状态管理、SSE 消费与样式分层。修改桌面端主进程、预加载、组件或样式时遵守。
globs: apps/desktop/**
alwaysApply: false
---

# 桌面端设计规范

## 1. 三层结构与边界

```text
apps/desktop/src/
├── main/        主进程（Node 环境）
├── preload/     预加载层，唯一的跨层出口
└── renderer/    Vue 3 渲染进程（浏览器环境）
```

- 主进程：应用生命周期与系统能力，不写界面逻辑。
- 预加载：只做能力白名单暴露与类型声明，不做业务判断。
- 渲染进程：界面与状态，绝不直接触碰 Node / Electron API。
- 新增能力时按"主进程实现 → 预加载暴露 → 渲染进程调用"的顺序添加，不跳层。

## 2. 主进程

- 职责按文件拆分，`index.ts` 只保留应用生命周期（单实例锁、`whenReady`、`activate`、`window-all-closed`）：
  - `settings.ts`：`settings.json` 读写与默认值
  - `theme.ts`：主题同步与窗口底色
  - `window.ts`：主窗口创建与页面加载
  - `ipc.ts`：IPC 处理器注册
- 设置持久化只经 `settings.ts`（`readSettings` / `writeSettings`，存 `app.getPath('userData')/settings.json`，读取失败回退 `DEFAULT_SETTINGS`）。
- 主题必须写两处，统一走 `theme.ts` 的 `applyTheme`：`nativeTheme.themeSource`（决定渲染进程的 `prefers-color-scheme`）与窗口 `setBackgroundColor`（决定首帧绘制前露出的底色）。只改一处会导致首屏闪烁或系统控件样式不一致。
- 窗口先 `ready-to-show` 再 `show`，避免白屏；外链交 `shell.openExternal` 并拒绝应用内新开窗口。
- 安全基线保持 `contextIsolation: true`、`nodeIntegration: false`，不放开渲染进程的 Node 能力。

## 3. IPC 契约

- 通道命名统一 `域:动作`，现有通道：`app:info`、`settings:get`、`settings:save`、`settings:get-sync`、`window:control`。
- 增删 IPC 必须三处同步：`main/ipc.ts` 注册 → `preload/index.ts` 白名单暴露 → `preload/types.ts` 类型声明。
- 预加载只暴露白名单方法，禁止暴露 `ipcRenderer` 本体或任意通道调用入口。
- 首帧就需要确定的设置用同步通道（`settings:get-sync` → `initialSettings`），其余一律异步。
- 渲染进程统一通过 `window.desktopApi` 调用，并对 `undefined` 兜底（浏览器调试环境不存在该对象）。

## 4. 渲染进程分层

```text
renderer/src/
├── types.ts        跨组件共享类型（ChatMessage、ConversationSummary 等）
├── api/client.ts   唯一的 HTTP 入口 AgentApi
├── composables/    跨组件共享的状态与业务（useAuth、useChat、useTheme）
├── App.vue         根组件（门禁与整体布局）
└── components/     展示与交互，每个组件一个目录
```

- `api/client.ts` 负责请求头拼装、中断/超时、错误归一化（`ApiError` 带 `status`，`isUnauthorized` 判定 401），其他模块不直接调用 `fetch`。
- `composables/` 承载跨组件共享的状态与业务（`useAuth` 的 token 与 user 为模块级单例）；组件私有的状态与交互留在组件目录内，不上提。
- `components/` 只做展示与交互，通过 props / emit 与 composable 交互。
- `components/` 下的组件一律以**目录**为单位组织，目录名即组件名：`Xxx/{index.ts, Xxx.vue, Xxx.less}`，按需再加 `useXxx.ts`。`index.ts` 统一 `export { default } from './Xxx.vue'`，消费方按 `import Xxx from '../components/Xxx'` 引入，不写 `.vue` 后缀。
- `components/` 下组件超过 200 行时按关注点拆到同目录：TS 逻辑（含 props / emits 类型定义）进 `useXxx.ts`，样式进 `Xxx.less`，`.vue` 只留模板与装配；不足 200 行不强行拆。
- `App.vue` 是唯一例外：作为根组件不目录化，保持单文件（门禁 + 布局 + 内联 scoped 样式块），不掺业务逻辑。

## 5. 数据流与错误处理

- 后端地址或 token 变化时，API 客户端用 `computed` 重建，避免持有过期实例。
- 401 统一处理：清除登录态并重置业务状态，回到登录页。
- 流式回复：先入列一条占位助手消息，`token` 事件累加正文；事件消费集中在模块级 `consumeChatStream()`，会话级副作用（切换会话、报错提示）通过回调交回调用方。
- 中断：保留 `AbortController`，停止按钮触发 `abort`，`finally` 中复位 streaming 状态。
- 用户可见文案一律中文；错误提示区分"网络不可达"与"业务错误"。

## 6. 主题与防闪烁

- 主题一致性涉及三处：HTML `data-theme`（渲染进程）、`nativeTheme.themeSource`（主进程）、窗口底色（主进程）。
- 首帧兜底：`data-theme` 写入前跟随系统偏好，由 `@media (prefers-color-scheme)` 兜底；主进程已按持久化设置设定 `themeSource`，两者结果一致。
- 切换过渡用一次性 `.theme-transition` 类（`TRANSITION_MS` 与 `variables.less` 的 `@theme-transition` 保持一致），动画结束即移除。
- 过渡只作用于大面积色块（`@theme-surfaces` 白名单），文字颜色不参与过渡；对全部元素做颜色过渡会让文本反复重算抗锯齿，表现为"字闪"。
- 尊重 `prefers-reduced-motion`，该设置下取消过渡。

## 7. 样式分层

- `styles/` 只放跨组件复用的公共样式，按 `theme`（色板）→ `motion` → `base` → `controls`（公共控件）聚合，导入顺序即层叠顺序。
- `components/` 下组件的私有样式写在组件目录的 `Xxx.less` 中，由 `.vue` 以 `<style src="./Xxx.less" lang="less" scoped>` 引入；`App.vue` 作为根组件仍用内联 `<style lang="less" scoped>`。判定标准是**被两个及以上组件复用才提炼到 `styles/`**（如 `.btn`、`.field`、`.chip`、`.dot` 被多个组件共用，属公共；`.session`、`.composer`、`.doc` 只服务单个组件，随组件走）。
- 组件样式用 `@import (reference)` 引入令牌与 mixin，路径按所在位置取值：组件目录为 `'../../styles/xxx.less'`，根组件 `App.vue` 为 `'./styles/xxx.less'`；`v-html` 注入的内容（markdown 正文）不带 scoped 属性，相关选择器须用 `:deep()` 穿透，且这部分规则单独放 `MessageItem/Markdown.less`，由 `MessageItem.less` 在其后 `@import` 引入，保证同特异性下靠源码顺序生效。
- 公共控件与组件的关系固定为「公共层定外观、组件层覆写尺寸」：组件 scoped 块只改 padding / 圆角 / 字号等尺寸项，材质（渐变、金线、阴影令牌）仍由 `controls.less` 提供。
- 与主题无关的尺寸、时长、字体放 `variables.less`；色值只放 `theme.less`；可复用片段放 `mixins.less`。
- 详细写法遵循 `.trae/rules/code-style.md` 的 Less 章节。

## 8. 新增设置项清单

1. `preload/types.ts` 的 `AppSettings` 补字段。
2. `main/settings.ts` 的 `DEFAULT_SETTINGS` 补默认值。
3. 需要主进程即时生效时，在 `ipc.ts` 的 `settings:save` 分支中处理（如主题、窗口底色）。
4. 渲染进程通过 composable 从 `initialSettings` / `desktopApi` 读取，不自行解析文件。

## 9. 构建与打包

- 链路：`electron-vite build` 产出 `out/{main,preload,renderer}`，再由 `electron-builder --win` 打成 `release/` 下的 NSIS 安装包与免安装的 `win-unpacked/`。
- `electron-builder.yml` 的 `files` 只收 `out/**` 与 `package.json`，源码不入包；`dependencies` 里的生产依赖由 electron-builder 自动打进 `app.asar`。
- 下载源必须显式声明：`electronDownload.mirror` 指向 npmmirror；工具链镜像（NSIS / 7zip / winCodeSign）没有对应配置项、只认 `ELECTRON_BUILDER_BINARIES_MIRROR`，由 `dist` 脚本经 `cross-env` 注入。`pnpm run` 不会把 `.npmrc` 的对应键注入为环境变量，不声明就会回落到 GitHub 重下整包（约 150 MB）而超时。
- 主进程与 preload 的依赖由 `externalizeDepsPlugin()` 外置，渲染进程的依赖由 Vite 打进 bundle。
- `out/` 与 `release/` 均为构建产物，不入库。

## 10. 自检清单

- `pnpm --filter @repo/desktop run build` 通过；需要安装包时 `run dist` 能产出 `release/` 下的 exe。
- 新增 IPC 已在注册、暴露、类型三处同步。
- 渲染进程未引入 Node / Electron API，未直接暴露 `ipcRenderer`。
- 主题切换无字闪，冷启动无深色闪烁。
- `components/` 下组件拆分后私有样式已随组件目录（`Xxx.less` + `<style src>` scoped）维护，根组件 `App.vue` 保持内联 scoped 块，跨组件复用的样式才注册到 `index.less`，类名仍为 BEM。
