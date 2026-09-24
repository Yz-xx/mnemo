# AI 智能体桌面应用（my-monorepo）

一个可本地运行的 AI 智能体应用：**Electron 桌面端**负责交互，**Express + LangChain 后端**负责推理与工具调用，账号与对话记录持久化在 **MySQL**，并内置一套**轻量 RAG 知识库**。整个仓库由 pnpm workspace 统一管理，一条命令即可拉起全链路。

- 桌面端：Electron 44 + Vue 3 + TypeScript + Less（electron-vite 构建）
- 后端：Express 5 + LangChain 1.x（`@langchain/ollama` / `@langchain/openai`）+ zod + mysql2
- 存储：MySQL 保存用户、登录会话与对话记录；知识库仍为本地 JSON
- 账号：注册 / 登录 / 登出，密码经 DES 加密后入库，接口以 Bearer 令牌鉴权
- 模型：默认本地 Ollama（`qwen2.5:7b` + `nomic-embed-text`），可选切换 OpenAI 兼容的线上服务

---

## 一、目录结构

```text
my-monorepo/
├── apps/
│   ├── backend/              # 智能体后端服务（Express + LangChain）
│   │   ├── src/
│   │   │   ├── index.ts              # 组合根：装配依赖、启动清理会话并监听端口
│   │   │   ├── config.ts             # 环境变量 → AppConfig
│   │   │   ├── app.ts                # createApp：组装中间件、注册路由与错误兜底
│   │   │   ├── dependencies.ts       # AppDependencies：路由层依赖契约（避免反向依赖）
│   │   │   ├── middleware/
│   │   │   │   ├── cors.ts           # 跨域放行（桌面端 file:// 场景）
│   │   │   │   └── errorHandler.ts   # 兜底错误处理
│   │   │   ├── auth/
│   │   │   │   ├── credentials.ts    # 用户名/密码格式校验
│   │   │   │   ├── userStore.ts      # 用户表读写（密码 DES 加密入库）
│   │   │   │   ├── sessionStore.ts   # 登录会话表（签发 / 校验 / 单端登录清理）
│   │   │   │   └── middleware.ts     # Bearer 令牌鉴权中间件
│   │   │   ├── db/
│   │   │   │   ├── pool.ts           # mysql2 连接池
│   │   │   │   └── schema.ts         # 启动自动建库建表
│   │   │   ├── llm/
│   │   │   │   ├── model.ts          # 对话模型 / 向量模型工厂
│   │   │   │   ├── agent.ts          # AgentService：ReAct 智能体与流式桥接
│   │   │   │   └── tools.ts          # 三个工具：检索 / 时间 / 计算
│   │   │   ├── rag/store.ts          # 知识库：切分 + 向量化 + 余弦检索
│   │   │   ├── conversation/store.ts # 会话与消息持久化（MySQL，按用户隔离）
│   │   │   ├── services/chatStream.ts # SSE 流式回复编排（推送事件 + 落库）
│   │   │   ├── routes/               # 各接口路由，index.ts 统一注册（含健康检查）
│   │   │   └── __vitest__/           # 单元测试（vitest 运行，不参与编译）
│   │   ├── .env.development          # 开发环境配置（pnpm dev 加载）
│   │   ├── .env.production           # 生产环境配置（pnpm start 加载）
│   │   └── data/                     # 运行时数据（知识库 JSON，已被 gitignore）
│   ├── desktop/              # Electron 桌面端
│   │   └── src/
│   │       ├── main/                 # 主进程：index.ts 只留生命周期，其余按职责分模块
│   │       │   ├── settings.ts       # settings.json 读写与默认值
│   │       │   ├── theme.ts          # 主题同步与窗口底色
│   │       │   ├── window.ts         # 主窗口创建
│   │       │   └── ipc.ts            # IPC 处理器注册
│   │       ├── preload/              # 预加载层：contextBridge 白名单 API
│   │       └── renderer/             # 渲染进程：Vue 3 界面与状态
│   └── frontend/             # 示例 Web 前端（脚手架预留）
├── packages/
│   ├── shared/               # 通用工具库（DES 加解密 / capitalize / truncate 等）
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
│  ├ 窗口创建 / 主题同步   ←──→ IPC 白名单 ←──→  useAuth / useChat / useTheme │
│  ├ settings.json 持久化        desktopApi                LoginView          │
│  └ nativeTheme.themeSource    （含登录令牌）              SessionSidebar     │
│                                                          ChatWindow         │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │ HTTP + SSE，Authorization: Bearer <token>
┌────────────────────────────────▼───────────────────────────────────────────┐
│                          后端（Express 5）                                  │
│  /api/health（公开）        /api/auth/*（注册/登录公开，登出/me 需登录）     │
│  /api/chat (SSE)   /api/conversations   /api/knowledge   ← 均需登录         │
│                                    │                                        │
│           requireAuth：校验 Bearer 令牌 → 注入 userId 到 res.locals         │
│                                    │                                        │
│                          AgentService（LangChain createAgent）              │
│                          ├ system prompt 约束                               │
│                          ├ 工具：search_knowledge_base / get_current_time   │
│                          │        calculator                                │
│                          └ 流式：streamMode = 'messages'                    │
│                                    │                                        │
│            KnowledgeStore（切分+向量+余弦）      UserStore / SessionStore /  │
│                       ↓                          ConversationStore           │
│              data/knowledge/store.json                      ↓               │
│                                                    MySQL（agent_data）      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 一次对话的完整数据流

1. 未登录时先渲染 `LoginView`；登录/注册成功后后端签发令牌（UUID），桌面端把令牌写入 `settings.json` 的 `authToken`，之后所有请求都带上 `Authorization: Bearer <token>`。
2. 用户在 `ChatWindow` 输入内容，`useChat.sendMessage` 立即把用户消息与一条**空的助手消息**插入列表（占位，用于承载流式 token）。
3. `AgentApi.streamChat` 以 `POST /api/chat` 建立连接，用 `AbortController` 支持随时停止。
4. 后端鉴权中间件由令牌解析出 `userId`，把用户消息写入该用户名下的会话（首次提问时自动创建会话并以首条消息生成标题）。
5. `AgentService` 把历史消息还原为 LangChain 消息对象，交给 `agent.stream(..., { streamMode: 'messages' })`。
6. 智能体按需调用工具：需要事实 → 检索/时间/计算；每次工具调用会被转成 `tool` 事件推给前端，形成消息下方的“调用工具 xxx / 完成 xxx”标签。
7. 模型增量输出被转成 `token` 事件，前端逐字追加渲染；流结束后后端把完整答复落库，再下发 `done`（携带 `conversationId` 与 `title`）。
8. 前端收到 `done` 后记录会话 ID 并刷新会话列表；若中途被用户中断，`signal` 会同步取消模型调用，避免继续消耗算力。
9. 任一请求返回 **401**（令牌过期或被新登录顶掉）时，桌面端清空本地登录态并回到登录页。

---

## 三、后端设计与实现

### 3.1 组合根与依赖装配

`apps/backend/src/index.ts` 是唯一的组合根：先读配置，`ensureSchema` 自动建库建表并创建连接池，随后依次创建 `UserStore` → `SessionStore` → `ConversationStore` → `KnowledgeStore` → `AgentService`，最后交给 `createApp` 组装并启动监听。`createApp` 只保留「通用中间件 → 注册路由 → 错误兜底」三段骨架，接口前缀与鉴权策略集中在 `routes/index.ts` 的 `registerRoutes` 声明，新增接口只需追加一行。所有依赖以参数显式注入（`AppDependencies`，定义于 `dependencies.ts`，避免路由反向依赖 `app.ts`），因此 `createApp` 可被单独引入做接口测试。

启动时还会执行 `sessionStore.prune()` 做一次会话清理（详见 3.3），并把清理条数打进启动日志。

### 3.2 HTTP 接口与鉴权

| 方法     | 路径                           | 鉴权   | 说明                                                    |
| -------- | ------------------------------ | ------ | ------------------------------------------------------- |
| `GET`    | `/api/health`                  | 公开   | 健康检查，返回提供方、当前对话模型、知识库状态          |
| `POST`   | `/api/auth/register`           | 公开   | 注册并直接签发令牌，成功返回 `201`（`{ token, user }`） |
| `POST`   | `/api/auth/login`              | 公开   | 登录并签发令牌，凭证错误返回 `401`                      |
| `POST`   | `/api/auth/logout`             | 需登录 | 删除当前令牌对应的会话，返回 `204`                      |
| `GET`    | `/api/auth/me`                 | 需登录 | 用本地令牌换取当前用户信息，令牌失效返回 `401`          |
| `POST`   | `/api/chat`                    | 需登录 | 流式对话（SSE），入参 `{ conversationId?, message }`    |
| `GET`    | `/api/conversations`           | 需登录 | 当前账号的会话摘要列表（按更新时间倒序）                |
| `GET`    | `/api/conversations/:id`       | 需登录 | 会话详情（含全部消息），非本人会话返回 `404`            |
| `DELETE` | `/api/conversations/:id`       | 需登录 | 删除会话（消息随外键级联删除）                          |
| `GET`    | `/api/knowledge/documents`     | 需登录 | 知识库文档列表                                          |
| `POST`   | `/api/knowledge/documents`     | 需登录 | 新增文档（同步完成切分与向量化）                        |
| `DELETE` | `/api/knowledge/documents/:id` | 需登录 | 删除文档及其全部片段                                    |

三个约定：

- **统一鉴权**：除 `/api/health` 与注册/登录外，其余路由都挂载 `requireAuth`；中间件从 `Authorization: Bearer <token>` 解析令牌，成功后将 `userId`/`token` 写入 **`res.locals`**（避免为扩展 `Express.Request` 引入全局类型声明），失败统一返回 `401 { message: '登录已失效，请重新登录' }`。
- **CORS 全放开**。桌面端在打包后可能以 `file://` 加载页面（Origin 为 `null`），因此统一返回 `Access-Control-Allow-Origin: *`，并在 `Access-Control-Allow-Headers` 中放行 `Authorization`。
- **兜底错误处理**。统一错误中间件透传 `error.status`（如 400/404），5xx 才打印日志并对外返回“服务内部错误”，避免异常导致连接悬挂。

### 3.3 账号与鉴权实现

**密码存储**：`UserStore` 直接复用 `@repo/shared` 的 `desEncrypt` 对密码加密后入库，不保存明文。采用 **ECB + PKCS7**（同一明文结果恒定），因此登录校验只需比对密文，无需解密；`authenticate` 对“用户不存在”与“密码错误”返回同一结果，由路由统一回以“用户名或密码错误”，不暴露账号是否已注册。注册走 `INSERT IGNORE`，命中 `username` 唯一索引时 `affectedRows = 0`，据此返回 `409`。

**令牌与会话**：登录/注册成功后由 `SessionStore.create()` 签发 UUID 令牌并写入 `user_sessions`，有效期 7 天。会话策略为**单端登录**——每个账号同时只保留一条有效会话，新登录顶掉旧会话：

```text
create()  ：同一事务内 DELETE 该 user 的全部旧会话 → INSERT 新令牌
            （放同一事务是为了避免中途失败时旧令牌已失效、新令牌又没落库）
resolve() ：按 token 查询；已过期则顺手删除并返回 null
prune()   ：启动时清理过期会话，并把历史遗留的同账号重复会话收敛为“仅保留最新一条”
```

> `prune()` 里的去重是一段自连接删除：保留每个账号 `created_at` 最新的一行（时间相同时用 `token` 兜底比较，保证结果确定）。这段逻辑是为收敛早期版本“每次登录都 INSERT 而不清理”留下的重复数据而加的。

### 3.4 数据表设计

`ensureSchema` 在启动时先以**不指定 database** 的连接 `CREATE DATABASE IF NOT EXISTS`，再连到该库执行建表（全部 `IF NOT EXISTS`，可重复执行）。四张表统一 `utf8mb4` / InnoDB：

| 表              | 关键字段                                                                         | 说明                                               |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `users`         | `id` 主键、`username` 唯一、`password`（DES 密文）                               | 账号表                                             |
| `user_sessions` | `token` 主键、`user_id` 索引、`expires_at`                                       | 登录会话表，单端登录下每个账号至多一行             |
| `conversations` | `id` 主键、`user_id`、`title`、`updated_at`（`(user_id, updated_at DESC)` 索引） | 对话表，列表查询走该复合索引                       |
| `messages`      | `id` 主键、`seq` 自增唯一、`conversation_id` 外键（`ON DELETE CASCADE`）         | 消息表，`seq` 保证读取顺序稳定，删会话即级联清消息 |

> 之所以用自增 `seq` 而非 `created_at` 排序：同一毫秒内写入的多条消息时间戳可能相同，`seq` 能提供严格稳定的顺序。

### 3.5 SSE 流式协议

`POST /api/chat` 的响应为 `text/event-stream`，每个事件都是 `data: <JSON>\n\n`，共四种：

| 事件    | 载荷                              | 触发时机                           |
| ------- | --------------------------------- | ---------------------------------- |
| `token` | `{ type, content }`               | 模型输出增量文本                   |
| `tool`  | `{ type, name, status }`          | 工具开始（`start`）/ 结束（`end`） |
| `done`  | `{ type, conversationId, title }` | 答复落库完成，本轮结束             |
| `error` | `{ type, message }`               | 推理过程异常                       |

中断处理是这段实现里最关键的一处细节：客户端关闭连接时必须立刻停下模型推理。实现上监听的是 `res` 而非 `req`——`req` 的 `close` 在请求体读取完成后就会触发，会误中断正常的流式响应；同时用 `res.writableEnded` 排除“正常结束”这一次回调，只有真正的提前断开才 `controller.abort()`。此外，仅在答复正文非空时落库，避免保存空回复。

这段编排独立在 `services/chatStream.ts` 的 `streamChatReply()` 中，`routes/chat.ts` 只保留入参校验（400 / 404）与用户消息落库，路由与流式协议解耦。

### 3.6 智能体（AgentService）

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

### 3.7 工具层

| 工具                    | 参数                 | 说明                                                       |
| ----------------------- | -------------------- | ---------------------------------------------------------- |
| `search_knowledge_base` | `query: string`      | 检索本地知识库，命中后以「【片段 n】来源《标题》」格式回填 |
| `get_current_time`      | 无                   | 返回 `Asia/Shanghai` 时区的当前时间                        |
| `calculator`            | `expression: string` | 计算 `+ - * / ( )` 算术表达式                              |

工具参数全部用 **zod schema** 声明，由框架负责校验与描述注入。

`calculator` 不直接 `eval` 任意代码，而是先做**白名单字符校验**（仅允许数字、运算符、括号与空白），通过后用 `new Function` 求值，并校验结果必须是有限数字；任何一步失败都返回可读提示而非抛错中断对话。

### 3.8 RAG 知识库

为了不引入外部向量数据库，`KnowledgeStore` 采用「内存态 + JSON 落盘」的极简实现：

```text
文档入库：RecursiveCharacterTextSplitter 切分 → embedDocuments 批量向量化 → 写入 data/knowledge/store.json
检索：embedQuery(query) → 与全部片段计算余弦相似度 → 排序取 Top-K
```

- 切分参数：`chunkSize = 500`、`chunkOverlap = 80`，检索 `topK = 4`（均可用环境变量覆盖）；
- 向量化失败（如本地 embedding 服务未启动）时接口返回 **502** 与可读的失败原因；
- 删除文档会级联清理其全部片段，保持索引与文档一致。

### 3.9 会话与消息持久化（MySQL）

会话与消息分别落在 `conversations` / `messages` 两张表，`ConversationStore` 提供 `list / get / create / append / remove`，**所有方法都带 `userId` 参数并以 `user_id` 作为查询条件**，从而保证多账号数据互不可见：读取他人会话返回 `null`（路由转成 `404`），删除他人会话影响行数为 0。

- `list(userId)`：按 `updated_at` 倒序返回摘要（ID、标题、更新时间、消息数），消息数由子查询统计；
- `get(userId, id)`：先按 `id + user_id` 校验归属，再按 `seq` 升序读出全部消息；
- `append(userId, id, role, content)`：未指定会话或会话不存在时自动 `create`；**首条用户消息**会被归一化空白后截断为 24 字作为会话标题（复用 `@repo/shared` 的 `truncate`）；写入消息后同步更新 `conversations.updated_at`；
- `remove(userId, id)`：删除会话行，其消息由外键 `ON DELETE CASCADE` 级联清除。

### 3.10 配置项

配置全部来自环境变量，部署时无需改代码。后端按环境加载两份文件（走 Node 原生 `--env-file`，无需 dotenv 依赖）：

| 文件                            | 加载时机                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| `apps/backend/.env.development` | `pnpm dev`，本地 Ollama + 本地 MySQL                                   |
| `apps/backend/.env.production`  | `pnpm start`，DeepSeek + 独立向量服务，敏感项为 `CHANGE_ME` 占位待替换 |

已存在的系统环境变量优先级高于文件，所以数据库密码与 API Key 在部署机上注入即可，不必写进仓库。

| 变量                                                           | 默认值                      | 说明                      |
| -------------------------------------------------------------- | --------------------------- | ------------------------- |
| `PORT`                                                         | `3000`                      | 服务端口                  |
| `DATA_DIR`                                                     | `<cwd>/data`                | 知识库数据目录            |
| `MYSQL_HOST`                                                   | `127.0.0.1`                 | MySQL 地址                |
| `MYSQL_PORT`                                                   | `3306`                      | MySQL 端口                |
| `MYSQL_USER`                                                   | `root`                      | MySQL 用户名              |
| `MYSQL_PASSWORD`                                               | `123456`                    | MySQL 密码                |
| `MYSQL_DATABASE`                                               | `agent_data`                | 库名（不存在时自动创建）  |
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

### 4.2 主进程

- **设置持久化**：`AppSettings`（`backendUrl`、`theme`、`authToken`）存放在 `app.getPath('userData')/settings.json`，避免写入安装目录导致权限问题；读取失败时回退默认值。登录令牌也保存在这里，用于下次启动恢复登录态。
- **窗口**：1200×800（最小 960×640）、隐藏菜单栏、`show: false` 配合 `ready-to-show` 再显示以消除白屏；外链交由系统浏览器打开；单实例锁保证重复启动时聚焦已有窗口。
- **主题同步**：`applyTheme()` 同时设置 `nativeTheme.themeSource`（决定渲染进程的 `prefers-color-scheme`）**和**窗口 `setBackgroundColor`（决定首帧绘制前露出的颜色）——两者缺一都会在启动时闪一下。
- **IPC 清单**：`app:info`、`settings:get`、`settings:save`、`settings:get-sync`（同步）、`window:control`（最小化/最大化/关闭）。

### 4.3 预加载层

`preload` 在**加载时同步**读取一次设置（`ipcRenderer.sendSync('settings:get-sync')`），并把它作为 `desktopApi.initialSettings` 注入。主题是需要“首帧即正确”的信息，异步 IPC 来不及，这一步是防闪烁链路的第一环。

对外 API：`initialSettings`、`getAppInfo()`、`getSettings()`、`saveSettings(partial)`、`windowControl(action)`。

### 4.4 渲染进程状态流

`useChat.ts` 集中管理会话状态（`connection / health / conversations / activeId / messages / streaming / errorMessage`）与全部请求动作：

- **流式渲染**：先把用户消息与一条空助手消息入列，`token` 事件直接追加到这条消息上，因此首字到达即渲染，不需要重排列表；事件消费由模块级 `consumeChatStream()` 承担，会话级副作用（切换会话、报错提示）以回调交回 composable，便于单独测试；
- **工具轨迹**：`tool` 事件映射为“调用工具 xxx”“完成 xxx”标签，追加到该条消息的 `steps`；
- **中断语义**：`AbortController` 保存在闭包局部变量中再另存引用——用户点“停止”会把外层引用置空，局部引用仍能判断“这次流是否被主动中断”，从而不把中断当成错误提示；
- **空回复回滚**：流结束后若助手消息仍无内容（例如模型直接失败），就把这条占位消息移除，避免留下空气泡；
- **连接状态**：`canSend` 要求后端在线且当前不在流式中，因此 `connection === 'offline'` 时输入区自动禁用。
- **登录态联动**：`api` 是 `computed`，令牌变化即重建客户端，保证每个请求都携带当前令牌；`handleError` 识别到 401 会清空登录态，`App.vue` 监听令牌变化后调用 `reset()` 清空会话数据，避免上一个账号的内容残留在界面上。

`api/client.ts` 负责 HTTP 与 SSE 解析：`buildHeaders()` 在已登录时统一附加 `Authorization: Bearer <token>`；非 2xx 时抛出携带状态码的 `ApiError`（`isUnauthorized` 据此识别登录失效），错误文案优先取服务端 `message` 字段；SSE 用 `ReadableStream` 逐块读取，按空行切分事件，**最后一段可能被截断，保留到下一轮再拼接**。

### 4.5 登录态与启动门禁

`useAuth.ts` 把登录态做成**模块级单例**（`token` / `user` / `submitting` / `errorMessage` 定义在模块作用域）——登录页、`useChat`、设置抽屉读到的都是同一份状态，避免各组件各持副本导致不同步：

- `restore()`：启动时从 `settings.json` 取回令牌，调用 `GET /api/auth/me` 校验；失败则静默清理，视为未登录；
- `submit(mode, ...)`：登录/注册成功后写入 `token` 与 `user`，并把令牌持久化到本地设置；
- `logout()`：先请求 `POST /api/auth/logout` 销毁服务端会话，**请求失败也继续本地清理**；`clear()` 则同时清空内存状态与本地令牌。

`App.vue` 承担门禁：`booting` 期间渲染空壳（等待 `restore()`），无令牌渲染 `LoginView`，有令牌才渲染主界面；令牌变化时同步 `init()` / `reset()` 切换数据源。`LoginView` 内置后端地址输入框与连通性探测，登录前即可发现地址填错。

### 4.6 主题机制与防闪烁

主题真源在主进程设置中，渲染侧由 `useTheme.ts` 承接：

1. 初始值取自 `bridge.initialSettings.theme`，并在模块初始化时**不加过渡**地写到 `document.documentElement.dataset.theme`；
2. 切换时只临时加 `.theme-transition` 类（240ms 后移除），常驻过渡会让滚动、hover 等交互动画变得迟钝；
3. 切换结果通过 `saveSettings({ theme })` 交回主进程持久化，主进程随即更新 `themeSource` 与窗口底色，保证下次启动不闪。

过渡样式在 `theme.less` 中被**限定在 18 个大面积表面元素**上，且只过渡 `background-color` 与 `border-color`：

> 早期的全局 `transition: all` 会让每个元素都参与颜色插值，深↔亮切换时文字色与背景色在中途交叉，出现约 100ms 的低对比度“字体闪烁”。改为“表面渐变、文字瞬时”后该现象消失。

### 4.7 样式体系（Less 模块化）

```text
renderer/src/styles/
├── variables.less           # 设计令牌：尺寸、圆角、字体栈、动效时长
├── theme.less               # 双主题色板 + 需要过渡的表面元素清单
├── mixins.less              # .ellipsis() .eyebrow() .focus-ring() .stagger() .content-gutter()
├── motion.less              # keyframes 与 .enter()，含 reduced-motion 兜底
├── base.less / layout.less  # 重置与整体布局
├── components/              # auth / controls / sidebar / chat / message / markdown / drawer / knowledge
└── index.less               # 入口，导入顺序即层叠顺序
```

要点：

- 颜色全部走 CSS 变量：深色主题在 `:root`，亮色主题由 `[data-theme='light']` 覆盖并设置 `color-scheme`，两套色板共用同一批语义令牌（`--bg` / `--bg-panel` / `--border-strong` / `--text-muted` / `--accent` …）；
- 排版有分工：标题与品牌用衬线显示字体，正文用无衬线，元信息（时间、会话数、模型名）用等宽小字 + 字距，形成“编辑级工作台”的观感；
- **布局中轴**由 `.content-gutter()` 混入统一：顶栏、消息列表、输入条共用同一条左右边界，其中消息列表额外补偿了 `scrollbar-gutter: stable` 造成的 10px 占位，保证头像与输入条右边界严格对齐；
- 两侧消息骨架对称：统一 `gap`、头像尺寸与 `align-self`，AI 侧用左侧细线（线）对应用户侧的浅色块（面），并用数值探针（而非肉眼）确认头像与正文首行中心误差在 1px 内；
- 用 `@import (reference)` 引入变量与 mixin，避免重复产出样式；`calc()` 参与运算的表达式用 `~'...'` 转义，交给浏览器求值。

### 4.8 界面组成

| 组件                 | 职责                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `App.vue`            | 布局骨架与登录门禁，串联登录页、侧栏、对话窗与设置抽屉                 |
| `LoginView.vue`      | 登录 / 注册表单，含后端地址配置与连通性探测                            |
| `SessionSidebar.vue` | 会话列表、新建/切换/删除、连接状态与模型信息、当前账号与登出、主题切换 |
| `ChatWindow.vue`     | 消息列表、空状态、输入条（Enter 发送 / Shift+Enter 换行）与停止按钮    |
| `MessageItem.vue`    | 单条消息：用户纯文本 / 助手 Markdown 渲染、工具轨迹标签、思考动画      |
| `SettingsDrawer.vue` | 抽屉外壳与标签页切换；「连接」页配置后端地址并探测连通性               |
| `KnowledgePanel.vue` | 「知识库」页：文档入库、列表与删除（挂载时自动加载）                   |

Markdown 由 `markdown-it` 渲染；对话内容以文档流形式呈现（不用气泡），配合衬线标题与克制的青绿强调色，长文阅读更接近阅读器体验。

---

## 五、工程化

### 5.1 workspace 与脚本编排

`pnpm-workspace.yaml` 收纳 `packages/*` 与 `apps/*`；根 `package.json` 的脚本不直接写长命令，而是交给 `scripts/` 下的编排脚本：

| 命令          | 实际行为                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------ |
| `pnpm dev`    | 交互选择要启动的应用，先构建 `packages/*`（后端直接消费其 `dist`），再并行跑所选应用的 dev |
| `pnpm build`  | 先打包 `packages/*`，再构建 `apps/*`                                                       |
| `pnpm lint`   | `eslint .` + `prettier --check .`（`pnpm lint:fix` 自动修复）                              |
| `pnpm test`   | `pnpm -r run test`，递归执行各子包单测（无 test 脚本的包自动跳过）                         |
| `pnpm format` | `prettier --write .`                                                                       |

### 5.2 依赖与镜像

- `.npmrc` 将 `electron_mirror` 与 `electron_builder_binaries_mirror` 指向 npmmirror，解决 Electron 及其打包依赖下载失败；
- `pnpm-workspace.yaml` 的 `allowBuilds` 显式放行 `esbuild`、`electron`、`electron-winstaller` 的安装脚本——它们分别需要校验平台原生二进制、下载 Electron 运行时；
- 提交前由 husky + lint-staged + commitlint（Conventional Commits）把关。

### 5.3 桌面端构建与打包

- `electron-vite dev / build / preview`：主进程与 preload 走 SSR 打包，渲染进程走 Vite；
- `pnpm --filter @repo/desktop run dist`：`electron-vite build && electron-builder --win`，产物落在 `apps/desktop/release/`，含 NSIS 安装包 `AgentDesktop Setup <version>.exe` 与免安装目录 `win-unpacked/`；
- preload 在 `type: module` 下输出为 `index.mjs`，主进程按该扩展名加载；
- 下载源必须显式指定：Electron 二进制在 `electron-builder.yml` 的 `electronDownload.mirror` 里指向 npmmirror，打包工具链（NSIS / 7zip / winCodeSign）的镜像由 `dist` 脚本用 `cross-env` 注入 `ELECTRON_BUILDER_BINARIES_MIRROR`。原因是 `pnpm run` 不会把 `.npmrc` 的 `electron_mirror` / `electron_builder_binaries_mirror` 注入为环境变量，不声明就会回落到 GitHub 重下整包（约 150 MB）而超时。

### 5.4 后端构建与运行

- `pnpm --filter @repo/backend run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build` 把 `src/index.ts` 打成单文件 `dist/index.js`（ESM + sourcemap，代码部分已压缩、不含空格与注释）；
- Vite 走服务端构建（`build.ssr`，`target: node20`），按 Node 环境解析依赖；目录下的 `.env.*` 由 `node --env-file` 在运行时读取，构建时以 `envDir: false` 关闭 Vite 自身的 env 加载；
- 运行期依赖（含 workspace 的 `@repo/shared`）与 Node 内置模块全部外置，产物中保留裸包名，部署时需一并安装 `dependencies`；
- 启动：`pnpm --filter @repo/backend run start`，即 `node --env-file=.env.production dist/index.js`。
- 产物中仍可见的换行与缩进都属于字符串内容（多行 SQL、系统提示词、SSE 报文的 `\n\n`），是数据而非格式：`\n\n` 是 SSE 协议分隔符，提示词换行影响模型输入，压缩器不会也不应改写它们。

### 5.5 公共库构建

- `pnpm --filter @repo/shared run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build`（库模式）产出 `dist/index.mjs`、`dist/index.cjs` 与 `dist/index.d.ts` 等类型声明；
- 产物保留空格与注释、开启 sourcemap，便于使用方调试；第三方运行时依赖（如 `crypto-js`）外置并保留裸包名，由使用方安装。

---

## 六、运行与验证

### 6.1 前置条件

Node.js ≥ 20、pnpm ≥ 9、本地 **MySQL 8**（默认 `127.0.0.1:3306`，账号 `root` / `123456`，可用环境变量覆盖，见 3.10），以及本地 Ollama：

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p   # 验证 MySQL 可连接（库表会在后端启动时自动创建）

ollama pull qwen2.5:7b          # 对话模型（必须支持工具调用）
ollama pull nomic-embed-text    # 向量模型
ollama serve
```

> 对话模型必须选择**支持 Function Calling** 的版本。例如 `deepseek-r1:7b` 不支持 Ollama 的函数调用，会导致模型不调用工具、直接编造答案；`qwen2.5:7b` 可正常使用。

### 6.2 启动

```bash
pnpm install
pnpm dev                        # 交互选择要启动的应用（默认全选，回车即启动全部）
pnpm dev backend desktop        # 也可直接指定，支持目录名（backend）或包名（@repo/backend）
```

`pnpm dev` 的交互菜单：`↑`/`↓` 移动光标、空格切换选中、`a` 全选/全不选、回车确认、`Esc` 取消；确认后先构建 `packages/*`，再用 `pnpm --parallel` 启动所选应用（桌面端会自行连接 http://localhost:3000）。在非交互环境（CI、输出被管道接管）下无法弹菜单，会自动启动全部应用。

单独运行某个应用：

```bash
pnpm --filter @repo/backend run dev     # tsx watch，默认 3000 端口
pnpm --filter @repo/desktop run dev     # electron-vite dev
```

### 6.3 质量校验

```bash
pnpm lint           # ESLint + Prettier
pnpm test           # 各子包单元测试（shared 的 DES 加解密、后端的凭证校验与知识库检索）
pnpm build          # 全仓构建
```

桌面端视觉改动可在构建产物上做静态验证：`electron-vite build` 后用任意静态服务器指向 `out/renderer`，再以无头 Chrome 截图核对两套主题。

---

## 七、已知约束与设计取舍

- **会话已改为 MySQL 持久化**：会话与消息按 `user_id` 隔离存储，天然支持多账号与并发访问；代价是 `append` 一次要写两张表（插入消息 + 更新会话时间），消息量极大时可考虑批量提交或异步刷写。
- **登录为单端登录**：每个账号同时只有一条有效会话，新登录顶掉旧会话；这保证了 `user_sessions` 不会累积重复行，但也意味着同账号无法多端同时在线。令牌明文保存在本机 `settings.json` 中，并随请求以 Bearer 明文传输，仅适用于本机/内网场景。
- **密码为 DES 加密而非哈希**：DES 为可逆对称加密，本项目按需求用它做存储加密（ECB 定值加密便于直接比对密文）；真正的生产系统应改用 bcrypt/argon2 这类加盐哈希。
- **知识库未按用户隔离**：文档与检索结果是全局共享的，任意登录用户都能查看与管理全部文档（本期未做权限划分）。
- **知识库为单进程内存态**：`KnowledgeStore` 在内存中维护全量片段，写入时整体覆写 `store.json`。多进程并发写会互相覆盖，因此按单实例部署；若需横向扩容，应替换为外部向量库。
- **检索为内存暴力排序**：全部片段逐个算余弦相似度再排序，简单可靠，适合中小规模语料；数据量增长后需引入向量索引。
- **system prompt 强约束检索**：以“必须检索后才回答”换取准确率，代价是知识库类问题必然会多一次工具往返。
- **主题过渡限定在表面元素**：牺牲了部分元素在切换时的平滑度，换取文字不闪烁与交互不迟钝。
- 仓库当前尚未提交首个 commit（`git init` 已完成）。
