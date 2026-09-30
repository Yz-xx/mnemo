---
description: apps/agent-client（Electron + Vue 3）的设计规范，涵盖三层结构与边界、主进程职责拆分、IPC 契约、主题与防闪烁处理、渲染进程状态管理、SSE 消费与样式分层。修改桌面端主进程、预加载、组件或样式时遵守。
globs: apps/agent-client/**
alwaysApply: false
---

# 桌面端设计规范

## 1. 三层结构与边界

```text
apps/agent-client/src/
├── main/        主进程（Node 环境）
├── preload/     预加载层，唯一的跨层出口
└── renderer/    Vue 3 渲染进程（浏览器环境）
```

- 主进程管应用生命周期与系统能力，不写界面逻辑；预加载只做能力白名单暴露与类型声明；渲染进程管界面与状态，绝不直接触碰 Node / Electron API。
- 新增能力按「主进程实现 → 预加载暴露 → 渲染进程调用」的顺序添加，不跳层。

## 2. 主进程

- `index.ts` 只保留应用生命周期（单实例锁、`whenReady`、`activate`、`window-all-closed`）；其余按文件拆：`settings.ts` 管 `settings.json` 读写、`theme.ts` 管主题与窗口底色、`window.ts` 管主窗口创建、`ipc.ts` 管 IPC 注册。
- 设置持久化只经 `settings.ts`（`readSettings` / `writeSettings`，存 `app.getPath('userData')/settings.json`，读取失败回退 `DEFAULT_SETTINGS`）；默认值只定义在 `preload/types.ts`，主进程与渲染进程共用一份。
- 主题必须写两处，统一走 `theme.ts` 的 `applyTheme`：`nativeTheme.themeSource` 与窗口 `setBackgroundColor`；只改一处会首屏闪烁或系统控件样式不一致。
- 窗口先 `ready-to-show` 再 `show`；外链交 `shell.openExternal`，拒绝应用内新开窗口。
- 安全基线保持 `contextIsolation: true`、`nodeIntegration: false`，不放开渲染进程的 Node 能力。

## 3. IPC 契约

- 通道命名统一 `域:动作`，现有通道：`app:info`、`settings:get`、`settings:save`、`settings:get-sync`、`dialog:open`（选择附件）、`dialog:save`（导出落盘）、`window:control`。
- 增删 IPC 必须三处同步：`main/ipc.ts` 注册 → `preload/index.ts` 白名单暴露 → `preload/types.ts` 类型声明。
- 预加载只暴露白名单方法，禁止暴露 `ipcRenderer` 本体或任意通道调用入口。
- 首帧就需要确定的设置用同步通道（`settings:get-sync` → `initialSettings`），其余一律异步。
- 渲染进程一律经 `api/bridge.ts` 读写桥接，不直接引用 `window.desktopApi`。

## 4. 渲染进程分层

```text
renderer/src/
├── types.ts         跨组件共享类型
├── api/bridge.ts    唯一的桥接入口：设置读写与首帧快照，无桥接时降级
├── api/client.ts    唯一的 HTTP 入口 AgentApi
├── api/session.ts   后端地址与登录令牌的单一来源，持有唯一 AgentApi 实例
├── composables/     跨组件共享的状态与业务，以及聊天流协议层
├── App.vue          根组件（门禁与整体布局）
└── components/      展示与交互，每个组件一个目录
```

- `api/bridge.ts` 导出 `initialSettings` 与 `readSettings` / `saveSettings`，无桥接时回退默认值，各模块不必自行判空。
- `api/client.ts` 是渲染进程**唯一依赖 `@repo/*` 的模块**：负责请求头拼装、中断/超时与错误归一化（`ApiError` 带 `status`、`isUnauthorized` 判 401、状态码取自 `HTTP_STATUS`，401 触发清除登录态、204 直接返回 `undefined` 不解析响应体），其余模块不直接调用 `fetch`，共享能力（`toErrorMessage`、`SESSION_EXPIRED_MESSAGE`）也从这里转发。
- `api/session.ts` 是会话唯一来源：地址与令牌以取值器注入 `AgentApi`，请求发起时才求值，切换地址或登录/登出都无需重建实例；仅「保存前先探测草稿地址」（登录页探活、设置抽屉预览）保留临时实例。
- `composables/` 承载跨组件共享的状态与业务，组件私有的状态留组件目录内；单文件超 250 行按关注点外提（纯函数层、独立子状态各自成文件），不做互相转发的碎类，跨层依赖用回调注入。
- `components/` 只做展示与交互，经 props / emit 与 composable 交互；一律以**目录**为单位组织，目录名即组件名（`Xxx/{index.ts, Xxx.vue, Xxx.less}`），`index.ts` 统一 `export { default } from './Xxx.vue'`，消费方按 `import Xxx from '../components/Xxx'` 引入，不写 `.vue` 后缀。
- 组件超 200 行按关注点拆到同目录：TS 逻辑进 `useXxx.ts`，样式进 `Xxx.less`，`.vue` 只留模板与装配。
- `App.vue` 是唯一例外：不目录化，保持单文件（门禁 + 布局 + 内联 scoped 样式），不掺业务逻辑。

## 5. 数据流与错误处理

- 后端地址与 token 由 `api/session.ts` 的模块级 ref 持有并以取值器注入 `AgentApi`，地址或登录态变化**无需重建实例**（不要用 `computed` 重建客户端）。
- 401 统一处理：清除登录态并重置业务状态，回到登录页。
- 流式回复：先入列占位助手消息，`token` 事件累加正文；事件消费集中在 `composables/chatStream.ts`，会话级副作用经回调交回调用方；`conversation` 事件在首个产出前到达，用于先记住会话 ID。
- 事件类型统一取 `@repo/reusable` 的 `ChatStreamEvent`（经 `api/client.ts` 转发），不在渲染进程自行声明联合，避免两端协议漂移。
- 中断保留 `AbortController`，停止按钮触发 `abort`，`finally` 中复位 streaming 状态。
- 用户可见文案一律中文，错误提示区分「网络不可达」与「业务错误」。

## 6. 主题与防闪烁

- 主题一致性涉及三处：HTML `data-theme`、`nativeTheme.themeSource`、窗口底色；首帧 `data-theme` 写入前跟随系统偏好，由 `@media (prefers-color-scheme)` 兜底，与主进程设定的 `themeSource` 一致。
- 切换过渡用一次性 `.theme-transition` 类（`TRANSITION_MS` 与 `variables.less` 的 `@theme-transition` 一致），动画结束即移除。
- 过渡只作用于 `@theme-surfaces` 白名单的大面积色块，文字颜色不参与（否则表现为「字闪」）。
- 尊重 `prefers-reduced-motion`，该设置下取消过渡。

## 7. 样式分层

- `styles/` 只放跨组件复用的公共样式，按 `theme`（色板）→ `motion` → `base` → `controls`（公共控件）聚合，导入顺序即层叠顺序。
- 组件私有样式写在组件目录的 `Xxx.less`，由 `.vue` 以 `<style src="./Xxx.less" lang="less" scoped>` 引入（`App.vue` 用内联 scoped 块）；**被两个及以上组件复用**才提炼到 `styles/`。
- 组件样式用 `@import (reference)` 引入令牌与 mixin，路径按位置取值：组件目录 `'../../styles/xxx.less'`，根组件 `'./styles/xxx.less'`。
- `v-html` 注入的内容不带 scoped 属性，相关选择器须用 `:deep()` 穿透，并单独放 `MessageItem/Markdown.less`，由 `MessageItem.less` 在其后 `@import` 引入。
- 公共控件与组件的关系固定为「公共层定外观、组件层覆写尺寸」；尺寸、时长、字体放 `variables.less`，色值只放 `theme.less`，可复用片段放 `mixins.less`。
- 详细写法遵循 `.trae/rules/code-style.md` 的 Less 章节。

## 8. 新增设置项清单

1. `preload/types.ts` 的 `AppSettings` 补字段。
2. `preload/types.ts` 的 `DEFAULT_SETTINGS` 补默认值（主进程与渲染进程共用一份）。
3. 需要主进程即时生效时，在 `ipc.ts` 的 `settings:save` 分支中处理（如主题、窗口底色）。
4. 渲染进程经 `api/bridge.ts` 读取，不直接引用 `window.desktopApi`，也不自行解析文件。

## 9. 构建与打包

- 链路：`electron-vite build` 产出 `out/{main,preload,renderer}`，再由 `electron-builder --win` 打成 `release/` 下的 NSIS 安装包与 `win-unpacked/`。
- `electron-builder.yml` 的 `files` 只收 `out/**` 与 `package.json`；`dependencies` 里的生产依赖由 electron-builder 自动打进 `app.asar`。
- 下载源必须显式声明：`electronDownload.mirror` 指向 npmmirror；`ELECTRON_BUILDER_BINARIES_MIRROR`（NSIS / 7zip / winCodeSign）由 `dist` 脚本经 `cross-env` 注入，否则会回落到 GitHub 重下整包。
- 主进程与 preload 的依赖由 `externalizeDepsPlugin()` 外置，渲染进程的依赖由 Vite 打进 bundle。
- `out/` 与 `release/` 为构建产物，不入库。

## 10. 自检清单

- `pnpm --filter @repo/agent-client run build` 通过；需要安装包时 `run dist` 能产出 `release/` 下的 exe。
- 新增 IPC 已在注册、暴露、类型三处同步。
- 渲染进程未引入 Node / Electron API，未直接暴露 `ipcRenderer`。
- 主题切换无字闪，冷启动无深色闪烁。
- `components/` 下组件拆分后私有样式随组件目录维护，跨组件复用的才注册到 `index.less`；`App.vue` 保持内联 scoped 块，类名仍为 BEM。
