# AI 智能体桌面应用（my-monorepo）

一个可本地运行的 AI 智能体应用：**Electron 桌面端**负责交互，**Express + LangChain 后端**负责推理与工具调用，并内置一套**轻量 RAG 知识库**。整个仓库由 pnpm workspace 统一管理，一条命令即可拉起全链路。

- 桌面端：Electron 44 + Vue 3 + TypeScript + Less（electron-vite 构建）
- 后端：Express 5 + LangChain 1.x（`@langchain/ollama` / `@langchain/openai`）+ zod
- 模型：默认本地 Ollama（`qwen2.5:7b` + `nomic-embed-text`），可选切换 OpenAI 兼容的线上服务

---

## 一、目录结构

```text
my-monorepo/
├── apps/
│   ├── backend/              # 智能体后端服务（Express + LangChain）
│   │   ├── src/
│   │   │   ├── index.ts              # 组合根：装配依赖并启动服务
│   │   │   ├── config.ts             # 环境变量 → AppConfig
│   │   │   ├── app.ts                # createApp：中间件与路由挂载
│   │   │   ├── llm/
│   │   │   │   ├── model.ts          # 对话模型 / 向量模型工厂
│   │   │   │   ├── agent.ts          # AgentService：ReAct 智能体与流式桥接
│   │   │   │   └── tools.ts          # 三个工具：检索 / 时间 / 计算
│   │   │   ├── rag/store.ts          # 知识库：切分 + 向量化 + 余弦检索
│   │   │   ├── conversation/store.ts # 会话持久化（一会话一 JSON）
│   │   │   └── routes/               # chat / conversations / knowledge
│   │   └── data/                     # 运行时数据（会话与知识库，已被 gitignore）
│   ├── desktop/              # Electron 桌面端
│   │   └── src/
│   │       ├── main/index.ts         # 主进程：窗口、设置、主题、IPC
│   │       ├── preload/              # 预加载层：contextBridge 白名单 API
│   │       └── renderer/             # 渲染进程：Vue 3 界面与状态
│   └── frontend/             # 示例 Web 前端（脚手架预留）
├── packages/
│   ├── shared/               # 通用工具库（capitalize / truncate 等）
│   └── components/           # 公共 Vue 组件库（Vite 库模式）
├── scripts/                  # dev / build / lint / test 编排脚本
├── pnpm-workspace.yaml
└── package.json
```

---

## 二、总体架构

```text
┌──────────────────────────── 桌面端（Electron） ────────────────────────────┐
│  主进程                       preload                    渲染进程 (Vue 3)   │
│  ├ 窗口创建 / 主题同步   ←──→ IPC 白名单 ←──→  useChat / useTheme          │
│  ├ settings.json 持久化        desktopApi                SessionSidebar     │
│  └ nativeTheme.themeSource                               ChatWindow         │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │ HTTP + SSE（默认 http://localhost:3000）
┌────────────────────────────────▼───────────────────────────────────────────┐
│                          后端（Express 5）                                  │
│  /api/health   /api/chat (SSE)   /api/conversations   /api/knowledge       │
│                                    │                                        │
│                          AgentService（LangChain createAgent）              │
│                          ├ system prompt 约束                               │
│                          ├ 工具：search_knowledge_base / get_current_time   │
│                          │        calculator                                │
│                          └ 流式：streamMode = 'messages'                    │
│                                    │                                        │
│         ConversationStore（JSON）        KnowledgeStore（切分+向量+余弦）    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 一次对话的完整数据流

1. 用户在 `ChatWindow` 输入内容，`useChat.sendMessage` 立即把用户消息与一条**空的助手消息**插入列表（占位，用于承载流式 token）。
2. `AgentApi.streamChat` 以 `POST /api/chat` 建立连接，用 `AbortController` 支持随时停止。
3. 后端把用户消息追加进会话文件（首次提问时自动创建会话并以首条消息生成标题）。
4. `AgentService` 把历史消息还原为 LangChain 消息对象，交给 `agent.stream(..., { streamMode: 'messages' })`。
5. 智能体按需调用工具：需要事实 → 检索/时间/计算；每次工具调用会被转成 `tool` 事件推给前端，形成消息下方的“调用工具 xxx / 完成 xxx”标签。
6. 模型增量输出被转成 `token` 事件，前端逐字追加渲染；流结束后后端把完整答复落库，再下发 `done`（携带 `conversationId` 与 `title`）。
7. 前端收到 `done` 后记录会话 ID 并刷新会话列表；若中途被用户中断，`signal` 会同步取消模型调用，避免继续消耗算力。

---

## 三、后端设计与实现

### 3.1 组合根与依赖装配

`apps/backend/src/index.ts` 是唯一的组合根：先读配置，再依次创建 `ConversationStore` → `KnowledgeStore` → `AgentService`，最后交给 `createApp` 组装路由。所有依赖以参数显式注入（`AppDependencies`），路由层只依赖抽象实例，因此 `createApp` 可被单独引入做接口测试。

### 3.2 HTTP 接口

| 方法     | 路径                           | 说明                                                 |
| -------- | ------------------------------ | ---------------------------------------------------- |
| `GET`    | `/api/health`                  | 健康检查，返回提供方、当前对话模型、知识库状态       |
| `POST`   | `/api/chat`                    | 流式对话（SSE），入参 `{ conversationId?, message }` |
| `GET`    | `/api/conversations`           | 会话摘要列表（按更新时间倒序）                       |
| `GET`    | `/api/conversations/:id`       | 会话详情（含全部消息）                               |
| `DELETE` | `/api/conversations/:id`       | 删除会话                                             |
| `GET`    | `/api/knowledge/documents`     | 知识库文档列表                                       |
| `POST`   | `/api/knowledge/documents`     | 新增文档（同步完成切分与向量化）                     |
| `DELETE` | `/api/knowledge/documents/:id` | 删除文档及其全部片段                                 |

两个约定：

- **CORS 全放开**。桌面端在打包后可能以 `file://` 加载页面（Origin 为 `null`），因此统一返回 `Access-Control-Allow-Origin: *`。
- **兜底错误处理**。统一错误中间件透传 `error.status`（如 400/404），5xx 才打印日志并对外返回“服务内部错误”，避免异常导致连接悬挂。

### 3.3 SSE 流式协议

`POST /api/chat` 的响应为 `text/event-stream`，每个事件都是 `data: <JSON>\n\n`，共四种：

| 事件    | 载荷                              | 触发时机                           |
| ------- | --------------------------------- | ---------------------------------- |
| `token` | `{ type, content }`               | 模型输出增量文本                   |
| `tool`  | `{ type, name, status }`          | 工具开始（`start`）/ 结束（`end`） |
| `done`  | `{ type, conversationId, title }` | 答复落库完成，本轮结束             |
| `error` | `{ type, message }`               | 推理过程异常                       |

中断处理是这段实现里最关键的一处细节：客户端关闭连接时必须立刻停下模型推理。实现上监听的是 `res` 而非 `req`——`req` 的 `close` 在请求体读取完成后就会触发，会误中断正常的流式响应；同时用 `res.writableEnded` 排除“正常结束”这一次回调，只有真正的提前断开才 `controller.abort()`。此外，仅在答复正文非空时落库，避免保存空回复。

### 3.4 智能体（AgentService）

采用 LangChain 的 `createAgent({ model, tools, systemPrompt })` 构建 ReAct 风格智能体，并以 `streamMode: 'messages'` 消费流——该模式能同时拿到文本增量与工具调用分片，是“边想边答 + 展示工具轨迹”的基础。

流桥接做了两件必要的适配：

- `AIMessageChunk.content` 可能是字符串，也可能是内容块数组，用 `extractText` 统一抽取纯文本；
- 一次工具调用会分散在多个分片中，用 `startedTools: Set` 去重，保证 `start` 事件只推送一次。

`system prompt` 是保证回答质量的核心约束（原文见 `agent.ts`）：

1. 需要事实信息时优先调用工具，不要凭空编造；
2. **涉及公司制度、业务流程、产品资料、内部规定、专有知识，或带有“知识库/文档/资料”字样时，必须先调用 `search_knowledge_base` 检索后再作答**，禁止凭记忆直接回答，检索为空时才说明“知识库中未找到相关内容”；
3. 涉及“今天/现在”等时间概念时调用 `get_current_time`；
4. 涉及算术运算时调用 `calculator`，不要心算；
5. 引用知识库内容时标注来源文档名称；
6. 使用简体中文、条理清晰，必要时用列表。

> 约束 2 是必需的：本地小模型在无强制要求时倾向于直接作答而不检索，这条规则把它拉回“先查后答”的链路。

### 3.5 工具层

| 工具                    | 参数                 | 说明                                                       |
| ----------------------- | -------------------- | ---------------------------------------------------------- |
| `search_knowledge_base` | `query: string`      | 检索本地知识库，命中后以「【片段 n】来源《标题》」格式回填 |
| `get_current_time`      | 无                   | 返回 `Asia/Shanghai` 时区的当前时间                        |
| `calculator`            | `expression: string` | 计算 `+ - * / ( )` 算术表达式                              |

工具参数全部用 **zod schema** 声明，由框架负责校验与描述注入。

`calculator` 不直接 `eval` 任意代码，而是先做**白名单字符校验**（仅允许数字、运算符、括号与空白），通过后用 `new Function` 求值，并校验结果必须是有限数字；任何一步失败都返回可读提示而非抛错中断对话。

### 3.6 RAG 知识库

为了不引入外部向量数据库，`KnowledgeStore` 采用「内存态 + JSON 落盘」的极简实现：

```text
文档入库：RecursiveCharacterTextSplitter 切分 → embedDocuments 批量向量化 → 写入 data/knowledge/store.json
检索：embedQuery(query) → 与全部片段计算余弦相似度 → 排序取 Top-K
```

- 切分参数：`chunkSize = 500`、`chunkOverlap = 80`，检索 `topK = 4`（均可用环境变量覆盖）；
- 向量化失败（如本地 embedding 服务未启动）时接口返回 **502** 与可读的失败原因；
- 删除文档会级联清理其全部片段，保持索引与文档一致。

### 3.7 会话持久化

一个会话对应 `data/conversations/<uuid>.json` 一个文件，`ConversationStore` 提供 `list / get / create / append / remove`：

- `list()` 读取目录并按 `updatedAt` 倒序返回摘要（ID、标题、更新时间、消息数）；
- `append()` 在会话不存在时自动新建；首条用户消息会被归一化空白后截断为 24 字，作为会话标题；
- 会话 ID 同时用作文件名，因此 `get()` 先用 UUID 正则校验，防止路径穿越。

### 3.8 配置项

配置全部来自环境变量（可写在 `.env` 中），部署时无需改代码：

| 变量                                                           | 默认值                      | 说明                      |
| -------------------------------------------------------------- | --------------------------- | ------------------------- |
| `PORT`                                                         | `3000`                      | 服务端口                  |
| `DATA_DIR`                                                     | `<cwd>/data`                | 会话与知识库数据目录      |
| `LLM_PROVIDER`                                                 | `ollama`                    | `ollama` 或 `deepseek`    |
| `LLM_TEMPERATURE`                                              | `0.3`                       | 采样温度                  |
| `OLLAMA_BASE_URL`                                              | `http://127.0.0.1:11434`    | Ollama 地址               |
| `OLLAMA_CHAT_MODEL`                                            | `qwen2.5:7b`                | 本地对话模型              |
| `OLLAMA_EMBEDDING_MODEL`                                       | `nomic-embed-text`          | 本地向量模型              |
| `DEEPSEEK_API_KEY`                                             | 空                          | 线上对话服务的密钥        |
| `DEEPSEEK_BASE_URL`                                            | `https://api.deepseek.com`  | DeepSeek 兼容 OpenAI 协议 |
| `DEEPSEEK_CHAT_MODEL`                                          | `deepseek-chat`             | 线上对话模型              |
| `EMBEDDING_PROVIDER`                                           | `ollama`                    | `ollama` 或 `openai`      |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` | `text-embedding-3-small` 等 | 线上向量服务配置          |
| `KNOWLEDGE_CHUNK_SIZE`                                         | `500`                       | 切片长度                  |
| `KNOWLEDGE_CHUNK_OVERLAP`                                      | `80`                        | 切片重叠                  |
| `KNOWLEDGE_TOP_K`                                              | `4`                         | 检索返回片段数            |

对话模型与向量模型**分开配置**：DeepSeek 不提供 embedding 接口，所以即便对话走线上，向量仍可继续使用本地 Ollama。

---

## 四、桌面端设计与实现

### 4.1 三层结构与职责

| 层       | 文件                   | 职责                                                   |
| -------- | ---------------------- | ------------------------------------------------------ |
| 主进程   | `src/main/index.ts`    | 窗口生命周期、`settings.json` 读写、主题同步、IPC 注册 |
| 预加载层 | `src/preload/index.ts` | `contextBridge` 暴露白名单 API，隔离 Node 能力         |
| 渲染进程 | `src/renderer/src/**`  | Vue 界面、状态管理、SSE 消费与主题切换                 |

安全配置：`contextIsolation: true`、`nodeIntegration: false`，渲染进程只能访问 preload 明确暴露的 `window.desktopApi`。

### 4.2 主进程

- **设置持久化**：`AppSettings`（`backendUrl`、`theme`）存放在 `app.getPath('userData')/settings.json`，避免写入安装目录导致权限问题；读取失败时回退默认值。
- **窗口**：1200×800（最小 960×640）、隐藏菜单栏、`show: false` 配合 `ready-to-show` 再显示以消除白屏；外链交由系统浏览器打开；单实例锁保证重复启动时聚焦已有窗口。
- **主题同步**：`applyTheme()` 同时设置 `nativeTheme.themeSource`（决定渲染进程的 `prefers-color-scheme`）**和**窗口 `setBackgroundColor`（决定首帧绘制前露出的颜色）——两者缺一都会在启动时闪一下。
- **IPC 清单**：`app:info`、`settings:get`、`settings:save`、`settings:get-sync`（同步）、`window:control`（最小化/最大化/关闭）。

### 4.3 预加载层

`preload` 在**加载时同步**读取一次设置（`ipcRenderer.sendSync('settings:get-sync')`），并把它作为 `desktopApi.initialSettings` 注入。主题是需要“首帧即正确”的信息，异步 IPC 来不及，这一步是防闪烁链路的第一环。

对外 API：`initialSettings`、`getAppInfo()`、`getSettings()`、`saveSettings(partial)`、`windowControl(action)`。

### 4.4 渲染进程状态流

`useChat.ts` 集中管理会话状态（`connection / health / conversations / activeId / messages / streaming / errorMessage`）与全部请求动作：

- **流式渲染**：先把用户消息与一条空助手消息入列，`token` 事件直接追加到这条消息上，因此首字到达即渲染，不需要重排列表；
- **工具轨迹**：`tool` 事件映射为“调用工具 xxx”“完成 xxx”标签，追加到该条消息的 `steps`；
- **中断语义**：`AbortController` 保存在闭包局部变量中再另存引用——用户点“停止”会把外层引用置空，局部引用仍能判断“这次流是否被主动中断”，从而不把中断当成错误提示；
- **空回复回滚**：流结束后若助手消息仍无内容（例如模型直接失败），就把这条占位消息移除，避免留下空气泡；
- **连接状态**：`canSend` 要求后端在线且当前不在流式中，因此 `connection === 'offline'` 时输入区自动禁用。

`api/client.ts` 负责 HTTP 与 SSE 解析：非 2xx 时尽量取服务端 `message` 字段作为错误文案；SSE 用 `ReadableStream` 逐块读取，按空行切分事件，**最后一段可能被截断，保留到下一轮再拼接**。

### 4.5 主题机制与防闪烁

主题真源在主进程设置中，渲染侧由 `useTheme.ts` 承接：

1. 初始值取自 `bridge.initialSettings.theme`，并在模块初始化时**不加过渡**地写到 `document.documentElement.dataset.theme`；
2. 切换时只临时加 `.theme-transition` 类（240ms 后移除），常驻过渡会让滚动、hover 等交互动画变得迟钝；
3. 切换结果通过 `saveSettings({ theme })` 交回主进程持久化，主进程随即更新 `themeSource` 与窗口底色，保证下次启动不闪。

过渡样式在 `theme.less` 中被**限定在 18 个大面积表面元素**上，且只过渡 `background-color` 与 `border-color`：

> 早期的全局 `transition: all` 会让每个元素都参与颜色插值，深↔亮切换时文字色与背景色在中途交叉，出现约 100ms 的低对比度“字体闪烁”。改为“表面渐变、文字瞬时”后该现象消失。

### 4.6 样式体系（Less 模块化）

```text
renderer/src/styles/
├── variables.less           # 设计令牌：尺寸、圆角、字体栈、动效时长
├── theme.less               # 双主题色板 + 需要过渡的表面元素清单
├── mixins.less              # .ellipsis() .eyebrow() .focus-ring() .stagger() .content-gutter()
├── motion.less              # keyframes 与 .enter()，含 reduced-motion 兜底
├── base.less / layout.less  # 重置与整体布局
├── components/              # controls / sidebar / chat / message / markdown / drawer
└── index.less               # 入口，导入顺序即层叠顺序
```

要点：

- 颜色全部走 CSS 变量：深色主题在 `:root`，亮色主题由 `[data-theme='light']` 覆盖并设置 `color-scheme`，两套色板共用同一批语义令牌（`--bg` / `--bg-panel` / `--border-strong` / `--text-muted` / `--accent` …）；
- 排版有分工：标题与品牌用衬线显示字体，正文用无衬线，元信息（时间、会话数、模型名）用等宽小字 + 字距，形成“编辑级工作台”的观感；
- **布局中轴**由 `.content-gutter()` 混入统一：顶栏、消息列表、输入条共用同一条左右边界，其中消息列表额外补偿了 `scrollbar-gutter: stable` 造成的 10px 占位，保证头像与输入条右边界严格对齐；
- 两侧消息骨架对称：统一 `gap`、头像尺寸与 `align-self`，AI 侧用左侧细线（线）对应用户侧的浅色块（面），并用数值探针（而非肉眼）确认头像与正文首行中心误差在 1px 内；
- 用 `@import (reference)` 引入变量与 mixin，避免重复产出样式；`calc()` 参与运算的表达式用 `~'...'` 转义，交给浏览器求值。

### 4.7 界面组成

| 组件                 | 职责                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| `App.vue`            | 布局骨架，串联侧栏、对话窗与设置抽屉                                     |
| `SessionSidebar.vue` | 会话列表、新建/切换/删除、连接状态与模型信息、主题切换                   |
| `ChatWindow.vue`     | 消息列表、空状态、输入条（Enter 发送 / Shift+Enter 换行）与停止按钮      |
| `MessageItem.vue`    | 单条消息：用户纯文本 / 助手 Markdown 渲染、工具轨迹标签、思考动画        |
| `SettingsDrawer.vue` | 抽屉面板：「连接」页配置后端地址并探测连通性，「知识库」页上传与删除文档 |

Markdown 由 `markdown-it` 渲染；对话内容以文档流形式呈现（不用气泡），配合衬线标题与克制的青绿强调色，长文阅读更接近阅读器体验。

---

## 五、工程化

### 5.1 workspace 与脚本编排

`pnpm-workspace.yaml` 收纳 `packages/*` 与 `apps/*`；根 `package.json` 的脚本不直接写长命令，而是交给 `scripts/` 下的编排脚本：

| 命令          | 实际行为                                                               |
| ------------- | ---------------------------------------------------------------------- |
| `pnpm dev`    | 先构建 `packages/*`（后端直接消费其 `dist`），再并行跑 `apps/*` 的 dev |
| `pnpm build`  | 先打包 `packages/*`，再构建 `apps/*`                                   |
| `pnpm lint`   | `eslint .` + `prettier --check .`（`pnpm lint:fix` 自动修复）          |
| `pnpm test`   | `pnpm -r run test`，递归执行各子包单测（无 test 脚本的包自动跳过）     |
| `pnpm format` | `prettier --write .`                                                   |

### 5.2 依赖与镜像

- `.npmrc` 将 `electron_mirror` 与 `electron_builder_binaries_mirror` 指向 npmmirror，解决 Electron 及其打包依赖下载失败；
- `pnpm-workspace.yaml` 的 `allowBuilds` 显式放行 `esbuild`、`electron`、`electron-winstaller` 的安装脚本——它们分别需要校验平台原生二进制、下载 Electron 运行时；
- 提交前由 husky + lint-staged + commitlint（Conventional Commits）把关。

### 5.3 桌面端构建与打包

- `electron-vite dev / build / preview`：主进程与 preload 走 SSR 打包，渲染进程走 Vite；
- `pnpm --filter @repo/desktop run dist`：`electron-vite build && electron-builder --win`，产出 Windows 安装包；
- preload 在 `type: module` 下输出为 `index.mjs`，主进程按该扩展名加载。

---

## 六、运行与验证

### 6.1 前置条件

Node.js ≥ 20、pnpm ≥ 9，以及本地 Ollama：

```bash
ollama pull qwen2.5:7b          # 对话模型（必须支持工具调用）
ollama pull nomic-embed-text    # 向量模型
ollama serve
```

> 对话模型必须选择**支持 Function Calling** 的版本。例如 `deepseek-r1:7b` 不支持 Ollama 的函数调用，会导致模型不调用工具、直接编造答案；`qwen2.5:7b` 可正常使用。

### 6.2 启动

```bash
pnpm install
pnpm dev            # 并行拉起后端与桌面端（桌面端会自行连接 http://localhost:3000）
```

单独运行某个应用：

```bash
pnpm --filter @repo/backend run dev     # tsx watch，默认 3000 端口
pnpm --filter @repo/desktop run dev     # electron-vite dev
```

### 6.3 质量校验

```bash
pnpm lint           # ESLint + Prettier
pnpm test           # 各子包单元测试（含 ConversationStore / KnowledgeStore）
pnpm build          # 全仓构建
```

桌面端视觉改动可在构建产物上做静态验证：`electron-vite build` 后用任意静态服务器指向 `out/renderer`，再以无头 Chrome 截图核对两套主题。

---

## 七、已知约束与设计取舍

- **知识库为单进程内存态**：`KnowledgeStore` 在内存中维护全量片段，写入时整体覆写 `store.json`。多进程并发写会互相覆盖，因此按单实例部署；若需横向扩容，应替换为外部向量库。
- **检索为内存暴力排序**：全部片段逐个算余弦相似度再排序，简单可靠，适合中小规模语料；数据量增长后需引入向量索引。
- **会话为全量覆写 JSON**：一个会话一个文件，读写简单直观；消息量极大时应改为追加式存储。
- **system prompt 强约束检索**：以“必须检索后才回答”换取准确率，代价是知识库类问题必然会多一次工具往返。
- **主题过渡限定在表面元素**：牺牲了部分元素在切换时的平滑度，换取文字不闪烁与交互不迟钝。
- 仓库当前尚未提交首个 commit（`git init` 已完成）。
