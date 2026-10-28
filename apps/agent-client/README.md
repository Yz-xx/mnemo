# @mnemo/agent-client 桌面端

Electron + Vue 3 的桌面客户端：承载登录、会话管理与流式对话界面，通过 HTTP + SSE 对接后端服务。

- 运行环境：Node ≥ 20、pnpm ≥ 9
- 技术栈：Electron 44 + Vue 3 + TypeScript + Less，构建工具为 electron-vite
- 目录分层：`src/main`（主进程）、`src/preload`（预加载）、`src/renderer`（渲染进程）

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)；后端接口与 SSE 协议见 [@mnemo/agent-server](../agent-server/README.md)；跨端可复用代码（状态码契约 / 对话协议类型 / 固定文案）见 [@mnemo/reusable](../../packages/reusable/README.md)，通用工具见 [@mnemo/shared](../../packages/shared/README.md)。

---

## 一、三层结构与职责

| 层       | 文件                   | 职责                                                      |
| -------- | ---------------------- | --------------------------------------------------------- |
| 主进程   | `src/main/index.ts`    | 应用生命周期：单实例锁、`whenReady`、`activate`、退出时机 |
|          | `src/main/settings.ts` | `settings.json` 读写与默认值                              |
|          | `src/main/theme.ts`    | 主题同步（`themeSource` + 窗口底色）                      |
|          | `src/main/window.ts`   | 主窗口创建与页面加载                                      |
|          | `src/main/ipc.ts`      | IPC 处理器注册                                            |
| 预加载层 | `src/preload/index.ts` | `contextBridge` 暴露白名单 API，隔离 Node 能力            |
| 渲染进程 | `src/renderer/src/**`  | Vue 界面、状态管理、SSE 消费与主题切换                    |

安全配置：`contextIsolation: true`、`nodeIntegration: false`，渲染进程只能访问 preload 明确暴露的 `window.desktopApi`。

## 二、主进程

- **设置持久化**：`AppSettings`（`backendUrl`、`theme`、`authToken`）存放在 `app.getPath('userData')/settings.json`，避免写入安装目录导致权限问题；读取失败时回退默认值。登录令牌也保存在这里，用于下次启动恢复登录态。
- **窗口**：1200×800（最小 960×640）、隐藏菜单栏、`show: false` 配合 `ready-to-show` 再显示以消除白屏；外链交由系统浏览器打开；单实例锁保证重复启动时聚焦已有窗口。
- **主题同步**：`applyTheme()` 同时设置 `nativeTheme.themeSource`（决定渲染进程的 `prefers-color-scheme`）**和**窗口 `setBackgroundColor`（决定首帧绘制前露出的颜色）——两者缺一都会在启动时闪一下。
- **IPC 清单**：`app:info`、`settings:get`、`settings:save`、`settings:get-sync`（同步）、`dialog:open`（附件选择）、`dialog:save`（导出落盘）、`window:control`（最小化/最大化/关闭）。

## 三、预加载层

`preload` 在**加载时同步**读取一次设置（`ipcRenderer.sendSync('settings:get-sync')`），并把它作为 `desktopApi.initialSettings` 注入。主题是需要“首帧即正确”的信息，异步 IPC 来不及，这一步是防闪烁链路的第一环。

对外 API：`initialSettings`、`getAppInfo()`、`getSettings()`、`saveSettings(partial)`、`openFile()`、`saveFile(file)`、`windowControl(action)`。

## 四、渲染进程状态流

`useChat.ts` 作为聚合入口，把会话状态与请求动作按关注点拆给四个子 composable——`useChatConnection`（连接与健康）、`useChatSession`（会话列表与切换）、`useChatMessages`（消息、流式消费与断点重连）、`useChatAttachments`（附件与导出），对外仍聚合出同一组状态（`connection / health / conversations / activeId / messages / streaming / loadingConversation / errorMessage / attachments`）与请求动作：

- **附件与导出**：发送前先经 `client.ts` 的 `uploadFile()` 上传附件，再带 `fileIds` 请求 `POST /api/chat`；`consumeChatStream()` 的 `file` 分支把导出文件写进该条助手消息的 `files`，`saveGeneratedFile()` 通过 `downloadFile(fileId)` 取回字节并经主进程 `saveFile` 落盘；
- **流式渲染**：先把用户消息与一条空助手消息入列，`token` 事件直接追加到这条消息上，因此首字到达即渲染，不需要重排列表；事件消费由纯函数层 `chatStream.ts` 的 `consumeChatStream()` 承担（入参是 `ChatStreamFrame`，按帧序号记录断点），会话级副作用（记住会话 ID、切换会话、报错提示）以回调交回 composable，便于单独测试。`conversation` 事件在首个产出之前到达，此时后端已确定这条会话会被保留，`activeId` 先记下来——用户中途点“停止”后仍能接着这条会话继续发；
- **消息列表窗口化**：`ChatWindow/useVirtualMessages.ts` 只挂载视口与上下各 0.75 屏缓冲，未测量项先按估算高度撑起总高、`ResizeObserver` 实测后回填；用户上翻即退出跟随（阈值 80 px），视口上方条目高度变化按 delta 补偿 `scrollTop`，流式中的末条单独强制挂载。几何计算全部收在纯函数层 `ChatWindow/windowing.ts`，由 `windowing.test.ts` 兜底；
- **推理链**：`thinking` 事件（仅在开启 `LLM_THINKING` 的模型上出现）累积到该条消息的 `thinking`，在正文之前渲染成可折叠的“思考过程”面板，正文首个 token 到达即自动收起；
- **工具轨迹**：`tool` 事件映射为“调用工具 xxx”“完成 xxx”标签，追加到该条消息的 `steps`；
- **检索来源**：`source` 事件把已注入模型上下文的文档名累积到该条消息的 `sources`，在工具轨迹下方临时渲染成“来源《文档名》”标签；流末尾的 `sources` 事件再用正文实际标注的文档覆盖它，正文一处都没标注时下发空清单，检索到但没采用的文档标签因此被清掉；
- **上下文治理提示**：`context` 事件只在服务端真的裁掉历史时到达，把 `trimmedMessages` / `summarized` 记在该条消息的 `context` 上，渲染成正文下方的一枚虚线标签（“已将 N 条更早的对话压缩为摘要”或“已丢弃 N 条更早的对话”）；它与 `thinking` 一样不落库，历史回看不还原；
- **断线续传与停止**：`roundId` 与 `AbortController` 由 `useChatMessages.ts` 持有。连接中途断开只退订订阅——服务端轮次继续在后台生成，客户端按 `RECONNECT_DELAYS_MS`（500 / 1000 / 2000 / 4000 ms）退避重连 `resumeChat(roundId, lastSeq)`，读到 `error`、404 或重试耗尽则降级为拉取已落库内容；用户点“停止”先调 `stopRound(roundId)` 显式中止本轮、再中止本地流，因此“主动停止”不会被当成错误提示；
- **空回复回滚**：流结束后若助手消息仍无内容（例如模型直接失败），就把这条占位消息移除，避免留下空气泡；
- **连接状态**：`canSend` 要求后端在线且当前不在流式中，因此 `connection === 'offline'` 时输入区自动禁用。
- **登录态联动**：请求经 `api/session.ts` 暴露的**唯一 `AgentApi` 实例**发出，地址与令牌在请求发起时才取值，因此登录/登出、切换后端地址都无需重建客户端；`handleError` 识别到 401 会清空登录态，`App.vue` 监听令牌变化后调用 `reset()` 清空会话数据，避免上一个账号的内容残留在界面上。

`api/client.ts` 负责 HTTP 与 SSE 解析：请求头拼装、错误归一化、超时与流式发送收在 `@mnemo/shared` 的通用客户端 `createHttpClient`（取舍见 [ADR 0013](../../docs/adr/0013-shared-http-client-via-fetch.md)），本模块只注入后端地址与令牌取值器、并把业务方法转发给它；非 2xx 抛出携带状态码的 `HttpError`，登录失效用 `@mnemo/reusable` 的 `isUnauthorized` 判定（契约外的码按 500 处理）；`ChatStreamEvent` / `ChatStreamFrame`（SSE 事件与带序号的一帧）与 `SESSION_EXPIRED_MESSAGE`（登录失效文案）同样取自 `@mnemo/reusable`，`toErrorMessage` 取自 `@mnemo/shared`，它是渲染进程唯一依赖 `@mnemo/*` 的模块（同时依赖这两个包），其余模块所需能力都从这里转发；附件下载走 `responseType: 'blob'`，SSE 走 `responseType: 'stream'` 拿到未消费的字节流后由 `@mnemo/reusable` 的 `parseSSEStream` 按空行切分、读 `id:` 行取序号，产出 `ChatStreamFrame`（**最后一段可能被截断，保留到下一轮再拼接**），`Authorization: Bearer <token>` 由客户端按 `getToken` 自动附加；`streamChat` 返回 `AsyncGenerator<ChatStreamFrame>`，本模块另暴露 `resumeChat(roundId, lastEventId)`（断点重连）与 `stopRound(roundId)`（显式停止）两个方法。

## 五、登录态与启动门禁

登录态做成**模块级单例**——`token` 与后端地址由 `api/session.ts` 持有（同一份 ref 供登录页、`useChat`、设置抽屉读取，并作为取值器注入唯一的 `AgentApi` 实例），`user` / `submitting` / `errorMessage` 由 `useAuth.ts` 在模块作用域维护，避免各组件各持副本导致不同步：

- `restore()`：启动时从 `settings.json` 取回令牌，调用 `GET /api/auth/me` 校验；失败则静默清理，视为未登录；
- `submit(mode, ...)`：登录/注册前先用服务端公钥加密口令（`encryptPassword`，明文不上网；取舍见 [ADR 0004](../../docs/adr/0004-password-transport-and-storage.md)），成功后写入 `token` 与 `user`，并把令牌持久化到本地设置；
- `logout()`：先请求 `POST /api/auth/logout` 销毁服务端会话，**请求失败也继续本地清理**；`clear()` 则同时清空内存状态与本地令牌。

`App.vue` 承担门禁：`booting` 期间渲染空壳（等待 `restore()`），无令牌渲染 `LoginView`，有令牌才渲染主界面；令牌变化时同步 `init()` / `reset()` 切换数据源。`LoginView` 内置后端地址输入框与连通性探测，登录前即可发现地址填错。

## 六、主题机制与防闪烁

主题真源在主进程设置中，渲染侧由 `useTheme.ts` 承接：

1. 初始值取自 `bridge.initialSettings.theme`，并在模块初始化时**不加过渡**地写到 `document.documentElement.dataset.theme`；
2. 切换时只临时加 `.theme-transition` 类（240ms 后移除），常驻过渡会让滚动、hover 等交互动画变得迟钝；
3. 切换结果通过 `saveSettings({ theme })` 交回主进程持久化，主进程随即更新 `themeSource` 与窗口底色，保证下次启动不闪。

过渡样式在 `theme.less` 中被**限定在 20 个大面积表面元素**上，且只过渡 `background-color` 与 `border-color`：

> 早期的全局 `transition: all` 会让每个元素都参与颜色插值，深↔亮切换时文字色与背景色在中途交叉，出现约 100ms 的低对比度“字体闪烁”。改为“表面渐变、文字瞬时”后该现象消失。

## 七、样式体系（Less 模块化）

```text
renderer/src/styles/          # 只放跨组件复用的公共样式
├── variables.less           # 设计令牌：尺寸、圆角、字体栈、动效时长
├── theme.less               # 双主题色板 + 需要过渡的表面元素清单
├── mixins.less              # .ellipsis() .eyebrow() .focus-ring() .stagger() .content-gutter()
├── motion.less              # 跨组件共用的 keyframes 与 .enter()
├── base.less                # 重置、窗口底色与全局滚动条
├── controls.less            # 公共控件：field / chip / dot / icon-btn / btn
└── index.less               # 入口，导入顺序即层叠顺序
```

`components/` 下的组件私有样式随组件目录走：写在同目录的 `Xxx.less`，由 `.vue` 以 `<style src="./Xxx.less" lang="less" scoped>` 引入（如 `SessionSidebar/SessionSidebar.less` 里的 `.sidebar` / `.session*`）；根组件 `App.vue` 不目录化，样式仍以内联 `<style lang="less" scoped>` 写在文件末尾。判定标准：**被两个及以上组件复用才提炼到 `styles/`**，只服务单个组件的样式一律留在组件内。

要点：

- 颜色全部走 CSS 变量：深色主题在 `:root`，亮色主题由 `[data-theme='light']` 覆盖并设置 `color-scheme`，两套色板共用同一批语义令牌（`--bg` / `--bg-panel` / `--border-strong` / `--text-muted` / `--accent` …）；
- 排版有分工：标题与品牌用衬线显示字体，正文用无衬线，元信息（时间、会话数、模型名）用等宽小字 + 字距，形成“编辑级工作台”的观感；
- **布局中轴**由 `.content-gutter()` 混入统一：顶栏、消息列表、输入条共用同一条左右边界，其中消息列表额外补偿了 `scrollbar-gutter: stable` 造成的 10px 占位，保证消息块与输入条右边界严格对齐；
- 消息骨架不分栏：不再有头像与左侧竖线，AI 回复区是纯文档流，用户消息是右对齐的无边框浅色块（`--bg-elevated` + 大圆角），两者只靠对齐与底色区分；正文 16px / 行高 1.75、消息间距 34px 拉开呼吸感；
- AI 回复下方有一条**操作行**（当前只有「复制」）：平时 `opacity: 0`，指针进入该条消息或内部获得焦点时才出现，避免每条回复都拖出一排图标；复制走 `navigator.clipboard.writeText`，成功后按钮自身变对勾并在 1.5s 后回落，不弹提示打断阅读；
- 组件样式文件内用 `@import (reference) '../../styles/variables.less'` 引入令牌与 mixin（`components/` 下组件目录比 `styles/` 深一层，根组件 `App.vue` 为 `'./styles/'`），`(reference)` 只取定义不产出、不会被重复打进产物；`calc()` 参与运算的表达式用 `~'...'` 转义，交给浏览器求值；
- `MessageItem/Markdown.less` 处理的正文由 `v-html` 注入，节点不带 scoped 属性，因此那部分选择器统一用 `:deep()` 穿透（如 `.markdown :deep(pre) code`）；该文件由 `MessageItem.less` 在其后 `@import` 引入，靠源码顺序覆盖骨架的 `white-space`；
- 公共控件与组件的作用关系是「组件覆写尺寸、公共层定外观」：如 `.composer__send` 位于 `ChatWindow/ChatWindow.less` 内，只定 32px 圆形与内距，金箔渐变与浮雕仍取 `controls.less` 的控件材质与 `theme.less` 的色板令牌；输入条自身拆成「上方写作区 + 下方操作行」两层，附件钮为带文字的胶囊、发送钮为圆形箭头（流式时换成方形停止图标）。

## 八、界面组成

| 组件              | 职责                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `App.vue`         | 布局骨架与登录门禁，串联登录页、侧栏、对话窗与设置抽屉                                                       |
| `LoginView/`      | 登录 / 注册表单，含后端地址配置与连通性探测                                                                  |
| `SessionSidebar/` | 会话列表、新建/切换/删除、连接状态与模型信息、当前账号与登出、主题切换                                       |
| `ChatWindow/`     | 消息列表、空状态、双层输入条（Enter 发送 / Shift+Enter 换行）、胶囊附件按钮与附件 chip、圆形发送 / 停止钮    |
| `MessageItem/`    | 单条消息：用户纯文本 / 助手 Markdown 渲染、工具轨迹与检索来源标签、思考动画、附件与导出文件 chip、复制操作行 |
| `SettingsDrawer/` | 抽屉外壳与标签页切换；「连接」页配置后端地址并探测连通性                                                     |
| `KnowledgePanel/` | 「知识库」页：文档入库、列表与删除（挂载时自动加载）                                                         |

`components/` 下每个组件目录内固定为 `Xxx.vue`（模板与装配）、`Xxx.less`（私有样式）与 `index.ts`（对外导出入口）；`ChatWindow/`、`LoginView/`、`SessionSidebar/`、`KnowledgePanel/` 另有 `useXxx.ts` 承载组件私有的状态与交互，`MessageItem/` 另拆出 `Markdown.less`。消费方一律按目录引入（`import ChatWindow from '../components/ChatWindow'`）；根组件 `src/App.vue` 保持单文件，由 `main.ts` 以 `import App from './App.vue'` 引入。

Markdown 由 `markdown-it` 渲染；AI 回复以文档流形式呈现（不加气泡），用户消息是右对齐的浅色块，配合衬线标题、金色发丝线与克制的香槟金强调色，长文阅读更接近阅读器体验。

## 九、构建与打包

- 三段式构建由 `electron-vite` 承担（对应根脚本 `pnpm --filter @mnemo/agent-client run dev / build / preview`）：主进程与 preload 走 SSR 打包，渲染进程走 Vite；
- `pnpm --filter @mnemo/agent-client run dist`：`electron-vite build && electron-builder --win`，产物落在 `apps/agent-client/release/`，含 NSIS 安装包 `Mnemo Setup <version>.exe` 与免安装目录 `win-unpacked/`；
- preload 在 `type: module` 下输出为 `index.mjs`，主进程按该扩展名加载；
- 下载源必须显式指定：Electron 二进制在 `electron-builder.yml` 的 `electronDownload.mirror` 里指向 npmmirror，打包工具链（NSIS / 7zip / winCodeSign）的镜像由 `dist` 脚本用 `cross-env` 注入 `ELECTRON_BUILDER_BINARIES_MIRROR`。原因是 `pnpm run` 不会把 `.npmrc` 的 `electron_mirror` 注入为环境变量，工具链镜像又只认环境变量、没有可写入的配置文件，不声明就会回落到 GitHub 重下整包（约 150 MB）而超时。

## 十、启动与验证

单独启动桌面端（会自行连接 `http://localhost:3000`，需后端已运行）：

```bash
pnpm --filter @mnemo/agent-client run dev     # electron-vite dev
```

视觉改动可在构建产物上做静态验证：`pnpm --filter @mnemo/agent-client run build` 后用任意静态服务器指向 `out/renderer`，再以无头 Chrome 截图核对两套主题。

## 十一、性能基线（阶段 0）

渲染链路的性能采集位于 `src/renderer/src/perf/renderMetrics.ts`，口径与取舍见 [ADR 0016](../../docs/adr/0016-streaming-render-performance.md)。采集器**只在开发模式安装**：生产构建里 `measureRender` 退化为直接调用，不产生计时开销。

### 采集字段

在 DevTools 控制台用 `__mnemoPerf.snapshot()` 读取快照，`__mnemoPerf.reset()` 清零后开始新一轮。若 `__mnemoPerf` 为 `undefined`，说明当前不是开发模式。

| 字段              | 含义                                   |
| ----------------- | -------------------------------------- |
| `renderCount`     | Markdown 解析次数，等于渲染次数        |
| `renderTotalMs`   | 解析累计耗时（毫秒）                   |
| `renderAvgMs`     | 单次解析平均耗时（毫秒）               |
| `renderMaxMs`     | 单次解析最长耗时（毫秒）               |
| `longTaskCount`   | 超过 50ms 的长任务数量                 |
| `longTaskTotalMs` | 长任务累计时长（毫秒）                 |
| `longTaskMaxMs`   | 单个长任务最长时长（毫秒）             |
| `domNodes`        | 当前文档中的 DOM 节点总数              |
| `heapUsedMb`      | JS 堆占用（MB），环境取不到时为 `null` |

### 测量口径

三件事必须固定，否则前后数字不可比：

- **同一台机器、同一份构建产物**：更换 Electron 版本、增删依赖后必须重测，不能沿用旧数字。
- **同一段语料**：提示词固定为「请用约 2000 字详细讲解 <主题>，包含至少两个代码块和一个表格」，并记录回答的实际字符数。
- **同一测量起点**：发送前必须 `__mnemoPerf.reset()`，快照是自上次清零以来的累计值。

### 操作步骤

1. `pnpm dev` 启动后端与桌面端（后端需 PostgreSQL + pgvector 与 Ollama 就绪）。
2. 桌面端按 `Ctrl+Shift+I` 打开 DevTools，切到 Console。
3. 执行 `__mnemoPerf.reset()`。
4. 发送语料提示词，等回答完整结束，全程不操作界面。
5. 执行 `__mnemoPerf.snapshot()`，把结果填进下表。
6. **长会话**：先切到消息最多的会话再做一次 `reset`，然后读 `domNodes` 与 `heapUsedMb`；切换耗时用 DevTools 的 Performance 面板录制「点击会话 → 消息渲染完成」区间，读 `Scripting` 与 `Rendering` 的小计。

### 基线表

测量条件：2026-10-28 ／ Electron 44.4.5（Vue 3.5.42 + markdown-it 15.0.2）／ 单轮回答 1843 字（含 2 个代码块与 1 个表格）／ 长会话 100 轮 = 200 条消息。数字来自本地开发机，跨机器不可直接比较。

| 指标                       | 单轮流式 | 长会话（200 条）       |
| -------------------------- | -------- | ---------------------- |
| 解析次数 `renderCount`     | 944      | 100                    |
| 解析累计 `renderTotalMs`   | 1161.5   | 77.5                   |
| 单次平均 `renderAvgMs`     | 1.23     | 0.775                  |
| 单次最长 `renderMaxMs`     | 36       | 7.2                    |
| 长任务数量 `longTaskCount` | 0        | 0                      |
| 最长长任务 `longTaskMaxMs` | 0        | 0                      |
| DOM 节点数 `domNodes`      | 217      | 3569                   |
| JS 堆占用 `heapUsedMb`     | 9.98     | 13.13                  |
| 端到端切换耗时             | —        | 1382 ms（含 API 往返） |

读法与结论：

- **流式路径的解析次数是历史渲染的 9.4 倍**（944 对 100）。历史消息内容不变，每条只解析一次；流式回答每来一个 token 就整段重解析一次，这正是 ADR 0016 要解决的问题。
- **单次解析只有 1.23 ms，代价来自次数而非单次耗时**：累计 1.16 秒主线程时间全部消耗在同一段文本的反复解析上。阶段 1 合帧后，解析次数应从「token 数」降到「帧数」量级。
- **本轮未产生任何长任务（>50 ms）**，说明 1843 字规模下解析本身还不足以卡住主线程。因此「逐 token 重解析」的真实代价须拆成「解析」与「`v-html` 整体替换 DOM」两段——**当前埋点只覆盖前者**，后者发生在浏览器渲染管线里，不在 `performance.now` 窗口内。这是本次测量的口径盲区，阶段 1 需补 `onBeforeUpdate` / `onUpdated` 的 DOM 更新耗时，或直接读 Performance 面板的 Rendering 分项。
- **长会话 200 条消息约 3569 个 DOM 节点**（约 17.8 节点/条），按 ADR 的 200 轮目标（400 条）线性外推约 7000 节点，规模并不爆炸。窗口化的收益主要在首次布局与滚动，须在阶段 3 用实测证明，不能只靠节点数叙事。

基线测得后，阶段 1 起的所有优化都以本表为对照物；表内数字一旦因环境变化失效，必须重新测量而不是沿用。

### 阶段 1 改造后的对照（合帧）

改造：正文与推理链的增量先进 `composables/frameWriter.ts` 缓冲，由 `requestAnimationFrame` 每帧提交一次；滚动跟随改为只观察条数与末条长度；`MessageItem` 用 `onBeforeUpdate` / `onUpdated` 补上 DOM 更新耗时。

测量前置：**窗口必须在前台可见**。窗口 `hidden` 时 Chromium 暂停 rAF，整轮增量会积到结束时的 `flush` 一次性提交（实测 1956 字只渲染 1 次）——内容不丢，但数字不代表真实渲染节奏。

| 指标                          | 阶段 0（逐 token，1843 字） | 阶段 1（合帧，2555 字） |
| ----------------------------- | --------------------------- | ----------------------- |
| 解析次数 `renderCount`        | 944                         | 1361                    |
| 解析累计 `renderTotalMs`      | 1161.5                      | 387.8                   |
| 单次平均 / 最长（ms）         | 1.23 / 36                   | 0.285 / 2               |
| DOM 更新次数 `domUpdateCount` | 未采集                      | 1965                    |
| DOM 更新累计 / 最长（ms）     | 未采集                      | 898.1 / 7.6             |
| 长任务数量 `longTaskCount`    | 0                           | 0                       |
| DOM 节点数 `domNodes`         | 217                         | 218                     |
| JS 堆占用 `heapUsedMb`        | 9.98                        | 10.3                    |
| 生成耗时                      | —                           | 63.7 s                  |

读法与结论：

- **合帧没有降低渲染次数**：按每字折算 0.51 对 0.53 次/字，基本持平。原因是本地 qwen3 的 token 到达速率低于 60 fps，每个 token 自成一帧，没有可合并的对象。合帧的收益条件是「token 速率高于帧率」，远程快模型与批量推帧才满足；在本地慢模型上它不改变渲染节奏。
- **两轮的单次解析耗时不可直接比较**（语料长度 1843 对 2555 字、进程 JIT 状态不同），不能把 1.23→0.285 ms 归因于合帧。
- **DOM 更新才是大头**：同一轮内部，DOM 更新累计 898.1 ms 是解析 387.8 ms 的 2.3 倍，阶段 0 的口径盲区得到证实。下一步的优化重心应放在减少 DOM 重建（阶段 2 块缓存：只重渲染未闭合块），而不是继续削减解析次数。
- **单轮流式总主线程占用约 1.29 秒 / 63.7 秒 ≈ 2%**，且零长任务。2555 字规模下逐 token 重解析不构成可感知卡顿；真正可感知的痛点在长会话（200 条 3569 节点、切换 1382 ms），对应阶段 3 的窗口化。

### 阶段 2 改造后的对照（块级 DOM 复用）

改造：正文改为按顶层块渲染（`MessageItem/markdown.ts` 的 `renderBlocks`），模板用 `v-for` + 索引 key + `v-html` 逐块绑定；`MarkdownIt` 提升为模块级单例；块容器以 `display: contents` 参与布局。

测量前置同阶段 1（窗口前台可见）。两轮使用同一提示词，但模型输出长度有波动，故同时给出按字折算值。

| 指标                          | 阶段 1（2555 字） | 阶段 2（2206 字） |
| ----------------------------- | ----------------- | ----------------- |
| 解析次数 `renderCount`        | 1361              | 1112              |
| 解析累计 `renderTotalMs`      | 387.8             | 251.1             |
| 解析单次平均 / 最长（ms）     | 0.285 / 2         | 0.226 / 12.7      |
| DOM 更新次数 `domUpdateCount` | 1965              | 1616              |
| DOM 更新累计 / 最长（ms）     | 898.1 / 7.6       | 475.6 / 12.9      |
| DOM 更新单次平均（ms）        | 0.457             | 0.294             |
| DOM 更新 ÷ 解析（同轮）       | 2.32              | 1.89              |
| 长任务数量 `longTaskCount`    | 0                 | 0                 |
| DOM 节点数 `domNodes`         | 218               | 237               |
| JS 堆占用 `heapUsedMb`        | 10.3              | 10.71             |

读法与结论：

- **DOM 重建成本降了四成左右**：累计 898.1 → 475.6 ms（-47.0%），按字折算 0.352 → 0.216 ms/字（-38.7%）；单次 0.457 → 0.294 ms（-35.7%）。语料短 13.7% 只能解释单次降幅的一部分，其余来自「只重设最后一块」。
- **块复用不是推断，是直接测到的**：流式进行中给已闭合的首块打 `data-probe` 标记并保存元素引用，结束后引用仍连在文档上、标记仍在、仍是首个子节点、文本逐字未变——该块 DOM 在整轮生成中从未被替换。
- **解析没有变快**：每帧仍对全文 `parse` 一次，`renderBlocks` 只把 render 与 DOM 做到块粒度。251.1 ms 与 387.8 ms 的差异来自语料结构与单例复用，不能算作块切分的收益。跳过已闭合块的 `parse` 需要分段解析，而引用式链接定义可跨块生效，语义风险大于收益，本次不做。
- **代价是多一层 wrapper 节点**：`display: contents` 不生成盒子，但节点仍计入 DOM（2206 字 37 块，218 → 237）。单次最长 12.7 ms 出现在首帧——此时整篇只有一块，等于全量渲染，仍远低于 50 ms 长任务阈值。

### 阶段 3 改造后的对照（窗口化）

改造：消息列表只挂载视口与上下各 0.75 屏缓冲（`ChatWindow/useVirtualMessages.ts`），几何计算收在纯函数 `ChatWindow/windowing.ts`；槽位绝对定位 + `translateY`，容器以虚拟总高撑开，间距改由偏移表计入；顶栏新增「复制对话」入口，补偿窗口化后 Ctrl+F 与全选只覆盖已挂载内容的取舍。

测量前置同阶段 1（窗口前台可见）。200 条样本按阶段 0 的同构语料重建，直接注入组件后测「到稳定帧」的纯渲染耗时。

| 指标                          | 阶段 0 基线（200 条）  | 阶段 3（200 条）      |
| ----------------------------- | ---------------------- | --------------------- |
| DOM 节点数 `domNodes`         | 3569                   | 134                   |
| 已挂载消息数                  | 200                    | 6                     |
| 解析次数 `renderCount`        | 100                    | 6                     |
| 解析累计 `renderTotalMs`      | 77.5                   | 0.3                   |
| DOM 更新次数 `domUpdateCount` | 未采集                 | 0                     |
| 长任务数量 `longTaskCount`    | 0                      | 0                     |
| 渲染侧耗时                    | 1382 ms（含 API 往返） | 35.5 ms（纯渲染注入） |

读法与结论：

- **DOM 节点数降 96.2%**（3569 → 134）：挂载数从 200 条降到 6 条，节点总数不再随会话长度增长，只随视口高度与缓冲区比例增长。
- **渲染侧耗时两轮口径不同，不能直接相减**：基线 1382 ms 是「点击会话 → 消息渲染完成」的端到端值，含一次 API 往返；本次 35.5 ms 是把消息直接注入组件后「到稳定帧」的纯渲染值。可比的结论是渲染侧已从「全量解析 + 全量布局」变为「只解析可见的 6 条」——解析次数 100 → 6 与基线同口径。
- **滚动无跳动是测出来的**：从 40% 位置向上滚 200 px，8 条已挂载消息位移全部为 200 px，`maxAbsDrift: 0`、`heightChange: 0`；滚到底后 `atBottom: 0`。
- **流式中上翻不会被内容推走**：跟随态 `atBottom: 0`；上翻 400 px 后 1.6 s 内 `atBottom` 保持 399、锚点消息 `drift: 0`；结束后自动贴底，DOM 137 节点、解析 62 次 / 6 ms、DOM 更新 243 次 / 32.2 ms、零长任务。

## 十二、已知约束与设计取舍

- **窗口化后 Ctrl+F 与全选只覆盖已挂载消息**：消息列表只保留视口 ± 0.75 屏，浏览器原生查找与「全选复制」拿不到未挂载的历史。补偿入口是顶栏的「复制对话」（按 role 加前缀拼接全部消息正文），原生查找仍受限，属有意取舍（见 [ADR 0016](../../docs/adr/0016-streaming-render-performance.md)）。
- **令牌明文保存在本机 `settings.json`** 并随请求以 Bearer 明文传输，仅适用于本机/内网场景。
- **主题过渡限定在表面元素**：牺牲了部分元素在切换时的平滑度，换取文字不闪烁与交互不迟钝。
- **历史会话不保留附件名**：`messages` 表没有附件列，附件名只在当轮内存中展示，重新载入历史会话时 `attachments` 为空（加列需引入迁移机制，收益不抵风险）。
