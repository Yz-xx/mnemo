# @repo/agent-client 桌面端

Electron + Vue 3 的桌面客户端：承载登录、会话管理与流式对话界面，通过 HTTP + SSE 对接后端服务。

- 运行环境：Node ≥ 20、pnpm ≥ 9
- 技术栈：Electron 44 + Vue 3 + TypeScript + Less，构建工具为 electron-vite
- 目录分层：`src/main`（主进程）、`src/preload`（预加载）、`src/renderer`（渲染进程）

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)；后端接口与 SSE 协议见 [@repo/agent-server](../agent-server/README.md)；跨端可复用代码（状态码契约 / 对话协议类型 / 固定文案）见 [@repo/reusable](../../packages/reusable/README.md)，通用工具见 [@repo/shared](../../packages/shared/README.md)。

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

`useChat.ts` 集中管理会话状态（`connection / health / conversations / activeId / messages / streaming / loadingConversation / errorMessage / attachments`）与全部请求动作：

- **附件与导出**：发送前先经 `client.ts` 的 `uploadFile()` 上传附件，再带 `fileIds` 请求 `POST /api/chat`；`consumeChatStream()` 的 `file` 分支把导出文件写进该条助手消息的 `files`，`saveGeneratedFile()` 通过 `downloadFile(fileId)` 取回字节并经主进程 `saveFile` 落盘；
- **流式渲染**：先把用户消息与一条空助手消息入列，`token` 事件直接追加到这条消息上，因此首字到达即渲染，不需要重排列表；事件消费由模块级 `consumeChatStream()` 承担，会话级副作用（记住会话 ID、切换会话、报错提示）以回调交回 composable，便于单独测试。`conversation` 事件在首个产出之前到达，此时后端已确定这条会话会被保留，`activeId` 先记下来——用户中途点“停止”后仍能接着这条会话继续发；
- **工具轨迹**：`tool` 事件映射为“调用工具 xxx”“完成 xxx”标签，追加到该条消息的 `steps`；
- **检索来源**：`source` 事件把命中的知识库文档名累积到该条消息的 `sources`，在工具轨迹下方渲染成“来源《文档名》”标签；来源由服务端在检索工具结束时确定地给出，不依赖模型在正文里标注出处；
- **中断语义**：`AbortController` 保存在闭包局部变量中再另存引用——用户点“停止”会把外层引用置空，局部引用仍能判断“这次流是否被主动中断”，从而不把中断当成错误提示；
- **空回复回滚**：流结束后若助手消息仍无内容（例如模型直接失败），就把这条占位消息移除，避免留下空气泡；
- **连接状态**：`canSend` 要求后端在线且当前不在流式中，因此 `connection === 'offline'` 时输入区自动禁用。
- **登录态联动**：`api` 是 `computed`，令牌变化即重建客户端，保证每个请求都携带当前令牌；`handleError` 识别到 401 会清空登录态，`App.vue` 监听令牌变化后调用 `reset()` 清空会话数据，避免上一个账号的内容残留在界面上。

`api/client.ts` 负责 HTTP 与 SSE 解析：状态码统一取自 `@repo/reusable` 的 `HTTP_STATUS`（如 401 触发重新登录、204 表示无响应体），响应状态码经 `toHttpStatusCode` 收敛后存入 `ApiError.status`，网关 / 代理注入的契约外码统一按 500 处理；`ChatStreamEvent`（SSE 事件类型）与 `SESSION_EXPIRED_MESSAGE`（登录失效文案）同样取自 `@repo/reusable`，`toErrorMessage` 取自 `@repo/shared`，它是渲染进程唯一依赖 `@repo/*` 的模块（同时依赖这两个包），其余模块所需能力都从这里转发；`buildHeaders()` 在已登录时统一附加 `Authorization: Bearer <token>`；非 2xx 时抛出携带状态码的 `ApiError`（`isUnauthorized` 据此识别登录失效），错误文案优先取服务端 `message` 字段；SSE 用 `ReadableStream` 逐块读取，按空行切分事件，**最后一段可能被截断，保留到下一轮再拼接**。

## 五、登录态与启动门禁

`useAuth.ts` 把登录态做成**模块级单例**（`token` / `user` / `submitting` / `errorMessage` 定义在模块作用域）——登录页、`useChat`、设置抽屉读到的都是同一份状态，避免各组件各持副本导致不同步：

- `restore()`：启动时从 `settings.json` 取回令牌，调用 `GET /api/auth/me` 校验；失败则静默清理，视为未登录；
- `submit(mode, ...)`：登录/注册成功后写入 `token` 与 `user`，并把令牌持久化到本地设置；
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

- 三段式构建由 `electron-vite` 承担（对应根脚本 `pnpm --filter @repo/agent-client run dev / build / preview`）：主进程与 preload 走 SSR 打包，渲染进程走 Vite；
- `pnpm --filter @repo/agent-client run dist`：`electron-vite build && electron-builder --win`，产物落在 `apps/agent-client/release/`，含 NSIS 安装包 `AgentDesktop Setup <version>.exe` 与免安装目录 `win-unpacked/`；
- preload 在 `type: module` 下输出为 `index.mjs`，主进程按该扩展名加载；
- 下载源必须显式指定：Electron 二进制在 `electron-builder.yml` 的 `electronDownload.mirror` 里指向 npmmirror，打包工具链（NSIS / 7zip / winCodeSign）的镜像由 `dist` 脚本用 `cross-env` 注入 `ELECTRON_BUILDER_BINARIES_MIRROR`。原因是 `pnpm run` 不会把 `.npmrc` 的 `electron_mirror` 注入为环境变量，工具链镜像又只认环境变量、没有可写入的配置文件，不声明就会回落到 GitHub 重下整包（约 150 MB）而超时。

## 十、启动与验证

单独启动桌面端（会自行连接 `http://localhost:3000`，需后端已运行）：

```bash
pnpm --filter @repo/agent-client run dev     # electron-vite dev
```

视觉改动可在构建产物上做静态验证：`pnpm --filter @repo/agent-client run build` 后用任意静态服务器指向 `out/renderer`，再以无头 Chrome 截图核对两套主题。

## 十一、已知约束与设计取舍

- **令牌明文保存在本机 `settings.json`** 并随请求以 Bearer 明文传输，仅适用于本机/内网场景。
- **主题过渡限定在表面元素**：牺牲了部分元素在切换时的平滑度，换取文字不闪烁与交互不迟钝。
- **历史会话不保留附件名**：`messages` 表没有附件列，附件名只在当轮内存中展示，重新载入历史会话时 `attachments` 为空（加列需引入迁移机制，收益不抵风险）。
