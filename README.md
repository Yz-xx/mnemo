# AI 智能体桌面应用（my-monorepo）

一个可本地运行的 AI 智能体应用：**Electron 桌面端**负责交互，**Express + LangChain 后端**负责推理与工具调用，账号与对话记录持久化在 **MySQL**，并内置一套 **LanceDB 向量知识库**（全局共享 + 用户私有）。整个仓库由 pnpm workspace 统一管理，一条命令即可拉起全链路。

- 桌面端：Electron 44 + Vue 3 + TypeScript + Less（electron-vite 构建）
- 后端：Express 5 + LangChain 1.x（`@langchain/ollama` / `@langchain/openai`）+ zod + mysql2
- 存储：MySQL 保存用户、登录会话与对话记录；知识库为本地 LanceDB 向量库
- 账号：注册 / 登录 / 登出，密码经 DES 加密后入库，接口以 Bearer 令牌鉴权
- 模型：默认本地 Ollama（`qwen2.5:7b` + `nomic-embed-text`），可选切换 OpenAI 兼容的线上服务

---

## 一、目录结构

```text
my-monorepo/
├── apps/
│   ├── agent-server/         # 智能体后端服务（Express + LangChain）
│   │   ├── src/
│   │   │   ├── index.ts              # 组合根：装配依赖、启动清理会话并监听端口
│   │   │   ├── config.ts             # 环境变量 → AppConfig
│   │   │   ├── app.ts                # createApp：组装中间件、注册路由与错误兜底
│   │   │   ├── dependencies.ts       # AppDependencies：路由层依赖契约（避免反向依赖）
│   │   │   ├── errors.ts             # 依赖服务连接错误翻译（toErrorMessage 在 @repo/shared）
│   │   │   ├── messages.ts           # 对外固定文案常量表（ERROR_MESSAGE）
│   │   │   ├── middleware/
│   │   │   │   ├── cors.ts           # 跨域放行（桌面端 file:// 场景）
│   │   │   │   ├── requestLog.ts     # 请求级日志（requestId + 入参出参摘要）
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
│   │   │   │   ├── prompt.ts         # system prompt 原文
│   │   │   │   └── tools.ts          # 三个工具：检索 / 时间 / 计算
│   │   │   ├── rag/store.ts          # 知识库：切分 + 向量化 + LanceDB 近邻检索
│   │   │   ├── conversation/store.ts # 会话与消息持久化（MySQL，按用户隔离）
│   │   │   ├── services/
│   │   │   │   ├── chatStream.ts     # SSE 流式回复编排（推送事件 + 落库）
│   │   │   │   └── knowledge.ts      # 文档入库编排（计时 + 日志）
│   │   │   ├── routes/               # 各接口路由，index.ts 统一注册（含健康检查）
│   │   │   └── __vitest__/           # 单元测试（vitest 运行，不参与编译）
│   │   ├── .env.development          # 开发环境配置（pnpm dev 加载）
│   │   ├── .env.production           # 生产环境配置（pnpm start 加载）
│   │   └── data/                     # 运行时数据（LanceDB 向量库，已被 gitignore）
│   ├── agent-client/         # Electron 桌面端
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
│   ├── shared/               # 跨端通用工具库（与业务无关：字符串 / 通用函数，DES 走 /crypto 子路径）
│   ├── reusable/             # 业务可复用库（HTTP 状态码契约 / SSE 对话协议类型 / 固定文案）
│   ├── logger/               # Node 端日志库（级别过滤 / 脱敏 / 按天轮转文件）
│   └── components/           # 公共 Vue 组件库（Vite 库模式）
├── docs/                     # 架构决策记录（ADR）
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
│           KnowledgeStore（LanceDB 向量近邻检索）  UserStore / SessionStore / │
│                       ↓                          ConversationStore           │
│              data/knowledge/lancedb                        ↓               │
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

## 三、各端文档

各端的设计细节、配置项与构建方式分别维护在各自的 README 中，本文只保留跨端的概览与约定：

| 文档                                                         | 内容范围                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [apps/agent-server/README.md](./apps/agent-server/README.md) | 后端接口与鉴权、账号与数据表、SSE 协议、智能体与工具层、LanceDB 知识库、会话持久化、配置项与构建    |
| [apps/agent-client/README.md](./apps/agent-client/README.md) | 三层结构与 IPC、渲染进程状态流、登录门禁、主题与防闪烁、Less 样式体系、界面组成、构建打包与视觉验证 |
| [packages/shared/README.md](./packages/shared/README.md)     | 通用工具库的导出索引（字符串 / 通用函数 / DES 加解密子路径）、引用方式与构建                        |
| [packages/reusable/README.md](./packages/reusable/README.md) | 业务可复用库的导出索引（HTTP 状态码契约 / SSE 对话协议类型 / 固定文案）、引用方式与构建             |
| [packages/logger/README.md](./packages/logger/README.md)     | Node 端日志库的导出能力（级别过滤 / 脱敏 / 格式化 / 文件轮转）、服务名前缀约定与构建                |

---

## 四、统一命令

`pnpm-workspace.yaml` 收纳 `packages/*` 与 `apps/*`；根 `package.json` 的脚本不直接写长命令，而是交给 `scripts/` 下的编排脚本：

| 命令          | 实际行为                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------ |
| `pnpm dev`    | 交互选择要启动的应用，先构建 `packages/*`（后端直接消费其 `dist`），再并行跑所选应用的 dev |
| `pnpm build`  | 先打包 `packages/*`，再构建 `apps/*`                                                       |
| `pnpm lint`   | `eslint .` + `prettier --check .`（`pnpm lint:fix` 自动修复）                              |
| `pnpm test`   | `pnpm -r run test`，递归执行各子包单测（无 test 脚本的包自动跳过）                         |
| `pnpm format` | `prettier --write .`                                                                       |

### 依赖与镜像

- `.npmrc` 将 `electron_mirror` 指向 npmmirror，解决 Electron 运行时下载失败；打包工具链（NSIS / 7zip / winCodeSign）的镜像没有对应配置项，由桌面端 `dist` 脚本经 `cross-env` 注入（见 [apps/agent-client/README.md](./apps/agent-client/README.md)）；
- `pnpm-workspace.yaml` 的 `allowBuilds` 显式放行 `esbuild`、`electron`、`electron-winstaller` 的安装脚本——它们分别需要校验平台原生二进制、下载 Electron 运行时；
- 提交前由 husky + lint-staged + commitlint（Conventional Commits）把关。

---

## 五、运行与质量校验

```bash
pnpm install
pnpm dev                             # 交互选择要启动的应用（默认全选，回车即启动全部）
pnpm dev agent-server agent-client   # 也可直接指定，支持目录名（agent-server）或包名（@repo/agent-server）
```

`pnpm dev` 的交互菜单：`↑`/`↓` 移动光标、空格切换选中、`a` 全选/全不选、回车确认、`Esc` 取消；确认后先构建 `packages/*`，再用 `pnpm --parallel` 启动所选应用（桌面端会自行连接 http://localhost:3000）。在非交互环境（CI、输出被管道接管）下无法弹菜单，会自动启动全部应用。

单独运行某个应用：

```bash
pnpm --filter @repo/agent-server run dev     # tsx watch，默认 3000 端口
pnpm --filter @repo/agent-client run dev     # electron-vite dev
```

前置条件（Node.js ≥ 20、pnpm ≥ 9、本地 MySQL 8 与 Ollama 的模型准备）见 [apps/agent-server/README.md](./apps/agent-server/README.md)。

质量校验：

```bash
pnpm lint           # ESLint + Prettier
pnpm test           # 各子包单元测试（shared 的 DES 加解密与错误消息提取、reusable 的 HTTP 状态码契约、logger 的格式化与文件轮转、后端的凭证校验与知识库检索）
pnpm build          # 全仓构建
```

---

## 六、跨端约束与设计取舍

- **密码为 DES 加密而非哈希**：`@repo/shared/crypto`（DES 单独走子路径入口，见 [packages/shared/README.md](./packages/shared/README.md)）提供 DES 加解密能力，后端按需求用它做存储加密（ECB 定值加密便于直接比对密文）；DES 为可逆对称加密，真正的生产系统应改用 bcrypt/argon2 这类加盐哈希。
- **令牌以明文流转**：登录令牌明文保存在桌面端 `settings.json` 中，并随请求以 Bearer 明文传输（后端只做校验与有效期管理），仅适用于本机/内网场景。
- **HTTP 状态码契约收敛为 7 项**：前后端共用 `@repo/reusable` 的 `HTTP_STATUS`（200/201/204/400/401/404/500），代码里不再写字面量数字；权限不足按 404、用户名冲突按 400、知识库入库失败按 500 处理，取舍见 [docs/adr/0001-http-status-contract.md](./docs/adr/0001-http-status-contract.md)。

各端自身的取舍（如后端的单端登录策略、桌面端的主题过渡范围）分别记在对应的子 README 中。
