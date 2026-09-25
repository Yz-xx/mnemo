# @repo/backend 智能体后端服务

Express 5 + LangChain 的智能体服务：对外提供账号鉴权、SSE 流式对话、会话持久化与向量知识库能力。

- 运行环境：Node ≥ 20（`type: module`，配置走 Node 原生 `--env-file` 加载）
- 技术栈：Express 5 + LangChain 1.x（`@langchain/ollama` / `@langchain/openai`）+ zod + mysql2
- 存储：MySQL 保存用户、登录会话与对话记录；知识库为本地 LanceDB 向量库
- 模型：默认本地 Ollama（`qwen2.5:7b` + `nomic-embed-text`），可选切换 OpenAI 兼容的线上服务

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)；公共工具库见 [@repo/shared](../../packages/shared/README.md)。

---

## 一、组合根与依赖装配

`src/index.ts` 是唯一的组合根：先读配置，`ensureSchema` 自动建库建表并创建连接池，随后依次创建 `UserStore` → `SessionStore` → `ConversationStore` → `KnowledgeStore` → `AgentService`，最后交给 `createApp` 组装并启动监听。`createApp` 只保留「通用中间件 → 注册路由 → 错误兜底」三段骨架，接口前缀与鉴权策略集中在 `routes/index.ts` 的 `registerRoutes` 声明，新增接口只需追加一行。所有依赖以参数显式注入（`AppDependencies`，定义于 `dependencies.ts`，避免路由反向依赖 `app.ts`），因此 `createApp` 可被单独引入做接口测试。

启动时还会执行 `sessionStore.prune()` 做一次会话清理（详见第三章），并把清理条数打进启动日志。

## 二、HTTP 接口与鉴权

| 方法     | 路径                              | 鉴权   | 说明                                                    |
| -------- | --------------------------------- | ------ | ------------------------------------------------------- |
| `GET`    | `/api/health`                     | 公开   | 健康检查，返回提供方、当前对话模型、知识库状态          |
| `POST`   | `/api/auth/register`              | 公开   | 注册并直接签发令牌，成功返回 `201`（`{ token, user }`） |
| `POST`   | `/api/auth/login`                 | 公开   | 登录并签发令牌，凭证错误返回 `401`                      |
| `POST`   | `/api/auth/logout`                | 需登录 | 删除当前令牌对应的会话，返回 `204`                      |
| `GET`    | `/api/auth/me`                    | 需登录 | 用本地令牌换取当前用户信息，令牌失效返回 `401`          |
| `POST`   | `/api/chat`                       | 需登录 | 流式对话（SSE），入参 `{ conversationId?, message }`    |
| `GET`    | `/api/conversations`              | 需登录 | 当前账号的会话摘要列表（按更新时间倒序）                |
| `GET`    | `/api/conversations/:id`          | 需登录 | 会话详情（含全部消息），非本人会话返回 `404`            |
| `DELETE` | `/api/conversations/:id`          | 需登录 | 删除会话（消息随外键级联删除）                          |
| `GET`    | `/api/knowledge/documents`        | 需登录 | 可见文档列表（全局共享 + 本人私有）                     |
| `POST`   | `/api/knowledge/documents`        | 需登录 | 新增私有文档（同步完成切分与向量化）                    |
| `POST`   | `/api/knowledge/global/documents` | 需登录 | 新增全局共享文档，需带 `x-admin-token` 管理令牌         |
| `DELETE` | `/api/knowledge/documents/:id`    | 需登录 | 删除文档及其全部片段；私有仅本人可删、全局仅管理员可删  |

三个约定：

- **统一鉴权**：除 `/api/health` 与注册/登录外，其余路由都挂载 `requireAuth`；中间件从 `Authorization: Bearer <token>` 解析令牌，成功后将 `userId`/`token` 写入 **`res.locals`**（避免为扩展 `Express.Request` 引入全局类型声明），失败统一返回 `401 { message: '登录已失效，请重新登录' }`。
- **CORS 全放开**。桌面端在打包后可能以 `file://` 加载页面（Origin 为 `null`），因此统一返回 `Access-Control-Allow-Origin: *`，并在 `Access-Control-Allow-Headers` 中放行 `Authorization`。
- **兜底错误处理**。统一错误中间件透传 `error.status`（如 400/404），5xx 才打印日志并对外返回“服务内部错误”，避免异常导致连接悬挂。

## 三、账号与鉴权实现

**密码存储**：`UserStore` 直接复用 `@repo/shared` 的 `desEncrypt` 对密码加密后入库，不保存明文。采用 **ECB + PKCS7**（同一明文结果恒定），因此登录校验只需比对密文，无需解密；`authenticate` 对“用户不存在”与“密码错误”返回同一结果，由路由统一回以“用户名或密码错误”，不暴露账号是否已注册。注册走 `INSERT IGNORE`，命中 `username` 唯一索引时 `affectedRows = 0`，据此返回 `409`。

**令牌与会话**：登录/注册成功后由 `SessionStore.create()` 签发 UUID 令牌并写入 `user_sessions`，有效期 7 天。会话策略为**单端登录**——每个账号同时只保留一条有效会话，新登录顶掉旧会话：

```text
create()  ：同一事务内 DELETE 该 user 的全部旧会话 → INSERT 新令牌
            （放同一事务是为了避免中途失败时旧令牌已失效、新令牌又没落库）
resolve() ：按 token 查询；已过期则顺手删除并返回 null
prune()   ：启动时清理过期会话，并把历史遗留的同账号重复会话收敛为“仅保留最新一条”
```

> `prune()` 里的去重是一段自连接删除：保留每个账号 `created_at` 最新的一行（时间相同时用 `token` 兜底比较，保证结果确定）。这段逻辑是为收敛早期版本“每次登录都 INSERT 而不清理”留下的重复数据而加的。

## 四、数据表设计

`ensureSchema` 在启动时先以**不指定 database** 的连接 `CREATE DATABASE IF NOT EXISTS`，再连到该库执行建表（全部 `IF NOT EXISTS`，可重复执行）。四张表统一 `utf8mb4` / InnoDB：

| 表              | 关键字段                                                                         | 说明                                               |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `users`         | `id` 主键、`username` 唯一、`password`（DES 密文）                               | 账号表                                             |
| `user_sessions` | `token` 主键、`user_id` 索引、`expires_at`                                       | 登录会话表，单端登录下每个账号至多一行             |
| `conversations` | `id` 主键、`user_id`、`title`、`updated_at`（`(user_id, updated_at DESC)` 索引） | 对话表，列表查询走该复合索引                       |
| `messages`      | `id` 主键、`seq` 自增唯一、`conversation_id` 外键（`ON DELETE CASCADE`）         | 消息表，`seq` 保证读取顺序稳定，删会话即级联清消息 |

> 之所以用自增 `seq` 而非 `created_at` 排序：同一毫秒内写入的多条消息时间戳可能相同，`seq` 能提供严格稳定的顺序。

## 五、SSE 流式协议

`POST /api/chat` 的响应为 `text/event-stream`，每个事件都是 `data: <JSON>\n\n`，共四种：

| 事件    | 载荷                              | 触发时机                           |
| ------- | --------------------------------- | ---------------------------------- |
| `token` | `{ type, content }`               | 模型输出增量文本                   |
| `tool`  | `{ type, name, status }`          | 工具开始（`start`）/ 结束（`end`） |
| `done`  | `{ type, conversationId, title }` | 答复落库完成，本轮结束             |
| `error` | `{ type, message }`               | 推理过程异常                       |

中断处理是这段实现里最关键的一处细节：客户端关闭连接时必须立刻停下模型推理。实现上监听的是 `res` 而非 `req`——`req` 的 `close` 在请求体读取完成后就会触发，会误中断正常的流式响应；同时用 `res.writableEnded` 排除“正常结束”这一次回调，只有真正的提前断开才 `controller.abort()`。此外，仅在答复正文非空时落库，避免保存空回复。

这段编排独立在 `services/chatStream.ts` 的 `streamChatReply()` 中，`routes/chat.ts` 只保留入参校验（400 / 404）与用户消息落库，路由与流式协议解耦。

## 六、智能体（AgentService）

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

## 七、工具层

| 工具                    | 参数                 | 说明                                                                   |
| ----------------------- | -------------------- | ---------------------------------------------------------------------- |
| `search_knowledge_base` | `query: string`      | 按当前用户可见性检索知识库，命中后以「【片段 n】来源《标题》」格式回填 |
| `get_current_time`      | 无                   | 返回 `Asia/Shanghai` 时区的当前时间                                    |
| `calculator`            | `expression: string` | 计算 `+ - * / ( )` 算术表达式                                          |

工具参数全部用 **zod schema** 声明，由框架负责校验与描述注入。

`calculator` 不直接 `eval` 任意代码，而是先做**白名单字符校验**（仅允许数字、运算符、括号与空白），通过后用 `new Function` 求值，并校验结果必须是有限数字；任何一步失败都返回可读提示而非抛错中断对话。

## 八、RAG 知识库（LanceDB）

知识库以 **LanceDB**（嵌入式向量库，落盘在 `data/knowledge/lancedb`）为存储，分两张表：`documents` 记录文档元数据，`chunks` 记录片段与向量。

```text
文档入库：RecursiveCharacterTextSplitter 切分 → embedDocuments 批量向量化 → 写入 documents / chunks
检索：embedQuery(query) → 向量近邻（cosine）+ 可见性过滤 → 取 Top-K
```

- **两级归属**：`scope = 'global'` 为全局共享，所有账号都可检索；`scope = 'private'` 仅 `owner_user_id` 本人可见。列表与检索统一按 `(scope = 'global' OR owner_user_id = <uid>)` 过滤；删除时私有文档仅本人可删、全局文档仅管理员可删，权限不足一律按“不存在”处理；
- **身份传递**：工具层没有天然的用户上下文，`AgentService.stream` 把 `userId` 放进 `configurable`，`search_knowledge_base` 从 `config.configurable.userId` 读取；读不到身份直接报错，而不是退化成“检索全部”；
- **全局文档入口**：客户端只上传私有文档，全局文档由 `POST /api/knowledge/global/documents` 维护，需带与 `KNOWLEDGE_ADMIN_TOKEN` 一致的管理令牌（令牌留空即关闭该接口）；
- **向量一致性**：首次入库时把向量模型名与维度登记在文档表，之后入库与检索都会校验；模型或维度变化时直接报错并提示重建，避免按较短维度截断算出错误的相似度；
- 切分参数：`chunkSize = 500`、`chunkOverlap = 80`，检索 `topK = 4`、相似度下限 `minScore = 0.6`（均可用环境变量覆盖）；
- 低于相似度下限的片段视为噪声丢弃，因此命中条数可能少于 `topK`；
- 向量化失败（如本地 embedding 服务未启动）时接口返回 **502** 与可读的失败原因（提示中带上当前向量化服务地址，便于区分“服务未启动”与“模型或维度不符”）；
- 删除文档会级联清理其全部片段，保持索引与文档一致。

## 九、会话与消息持久化（MySQL）

会话与消息分别落在 `conversations` / `messages` 两张表，`ConversationStore` 提供 `list / get / create / append / remove`，**所有方法都带 `userId` 参数并以 `user_id` 作为查询条件**，从而保证多账号数据互不可见：读取他人会话返回 `null`（路由转成 `404`），删除他人会话影响行数为 0。

- `list(userId)`：按 `updated_at` 倒序返回摘要（ID、标题、更新时间、消息数），消息数由子查询统计；
- `get(userId, id)`：先按 `id + user_id` 校验归属，再按 `seq` 升序读出全部消息；
- `append(userId, id, role, content)`：未指定会话或会话不存在时自动 `create`；**首条用户消息**会被归一化空白后截断为 24 字作为会话标题（复用 `@repo/shared` 的 `truncate`）；写入消息后同步更新 `conversations.updated_at`；
- `remove(userId, id)`：删除会话行，其消息由外键 `ON DELETE CASCADE` 级联清除。

## 十、配置项

配置全部来自环境变量，部署时无需改代码。后端按环境加载两份文件（走 Node 原生 `--env-file`，无需 dotenv 依赖）：

| 文件               | 加载时机                                                               |
| ------------------ | ---------------------------------------------------------------------- |
| `.env.development` | `pnpm dev`，本地 Ollama + 本地 MySQL                                   |
| `.env.production`  | `pnpm start`，DeepSeek + 独立向量服务，敏感项为 `CHANGE_ME` 占位待替换 |

已存在的系统环境变量优先级高于文件，所以数据库密码与 API Key 在部署机上注入即可，不必写进仓库。

| 变量                                                           | 默认值                      | 说明                                     |
| -------------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| `PORT`                                                         | `3000`                      | 服务端口                                 |
| `DATA_DIR`                                                     | `<cwd>/data`                | 知识库数据目录                           |
| `MYSQL_HOST`                                                   | `127.0.0.1`                 | MySQL 地址                               |
| `MYSQL_PORT`                                                   | `3306`                      | MySQL 端口                               |
| `MYSQL_USER`                                                   | `root`                      | MySQL 用户名                             |
| `MYSQL_PASSWORD`                                               | `123456`                    | MySQL 密码                               |
| `MYSQL_DATABASE`                                               | `agent_data`                | 库名（不存在时自动创建）                 |
| `LLM_PROVIDER`                                                 | `ollama`                    | `ollama` 或 `deepseek`                   |
| `LLM_TEMPERATURE`                                              | `0.3`                       | 采样温度                                 |
| `OLLAMA_BASE_URL`                                              | `http://127.0.0.1:11434`    | Ollama 地址                              |
| `OLLAMA_CHAT_MODEL`                                            | `qwen2.5:7b`                | 本地对话模型                             |
| `OLLAMA_EMBEDDING_MODEL`                                       | `nomic-embed-text`          | 本地向量模型                             |
| `DEEPSEEK_API_KEY`                                             | 空                          | 线上对话服务的密钥                       |
| `DEEPSEEK_BASE_URL`                                            | `https://api.deepseek.com`  | DeepSeek 兼容 OpenAI 协议                |
| `DEEPSEEK_CHAT_MODEL`                                          | `deepseek-chat`             | 线上对话模型                             |
| `EMBEDDING_PROVIDER`                                           | `ollama`                    | `ollama` 或 `openai`                     |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` | `text-embedding-3-small` 等 | 线上向量服务配置                         |
| `KNOWLEDGE_CHUNK_SIZE`                                         | `500`                       | 切片长度                                 |
| `KNOWLEDGE_CHUNK_OVERLAP`                                      | `80`                        | 切片重叠                                 |
| `KNOWLEDGE_TOP_K`                                              | `4`                         | 检索返回片段数                           |
| `KNOWLEDGE_MIN_SCORE`                                          | `0.6`                       | 检索相似度下限（低于该分数的片段丢弃）   |
| `KNOWLEDGE_ADMIN_TOKEN`                                        | 空                          | 全局知识库管理令牌（留空即关闭全局写入） |

对话模型与向量模型**分开配置**：DeepSeek 不提供 embedding 接口，所以即便对话走线上，向量仍可继续使用本地 Ollama。

## 十一、前置条件与启动

依赖 Node.js ≥ 20、pnpm ≥ 9、本地 **MySQL 8**（默认 `127.0.0.1:3306`，账号 `root` / `123456`，可用环境变量覆盖，见第十章），以及本地 Ollama：

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p   # 验证 MySQL 可连接（库表会在后端启动时自动创建）

ollama pull qwen2.5:7b          # 对话模型（必须支持工具调用）
ollama pull nomic-embed-text    # 向量模型
ollama serve
```

> 对话模型必须选择**支持 Function Calling** 的版本。例如 `deepseek-r1:7b` 不支持 Ollama 的函数调用，会导致模型不调用工具、直接编造答案；`qwen2.5:7b` 可正常使用。

单独启动后端（默认 3000 端口，`tsx watch`）：

```bash
pnpm --filter @repo/backend run dev
```

## 十二、构建与运行

- `pnpm --filter @repo/backend run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build` 把 `src/index.ts` 打成单文件 `dist/index.js`（ESM + sourcemap，代码部分已压缩、不含空格与注释）；
- Vite 走服务端构建（`build.ssr`，`target: node20`），按 Node 环境解析依赖；目录下的 `.env.*` 由 `node --env-file` 在运行时读取，构建时以 `envDir: false` 关闭 Vite 自身的 env 加载；
- 运行期依赖（含 workspace 的 `@repo/shared`）与 Node 内置模块全部外置，产物中保留裸包名，部署时需一并安装 `dependencies`；
- 启动：`pnpm --filter @repo/backend run start`，即 `node --env-file=.env.production dist/index.js`。
- 产物中仍可见的换行与缩进都属于字符串内容（多行 SQL、系统提示词、SSE 报文的 `\n\n`），是数据而非格式：`\n\n` 是 SSE 协议分隔符，提示词换行影响模型输入，压缩器不会也不应改写它们。

## 十三、已知约束与设计取舍

- **会话已改为 MySQL 持久化**：会话与消息按 `user_id` 隔离存储，天然支持多账号与并发访问；代价是 `append` 一次要写两张表（插入消息 + 更新会话时间），消息量极大时可考虑批量提交或异步刷写。
- **登录为单端登录**：每个账号同时只有一条有效会话，新登录顶掉旧会话；这保证了 `user_sessions` 不会累积重复行，但也意味着同账号无法多端同时在线。
- **system prompt 强约束检索**：以“必须检索后才回答”换取准确率，代价是知识库类问题必然会多一次工具往返。
- **知识库检索为暴力近邻**：LanceDB 表内逐个算 cosine 相似度再排序，简单可靠，适合中小规模语料；数据量增长后需补建 ANN 索引。
