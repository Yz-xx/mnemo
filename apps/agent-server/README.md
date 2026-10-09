# @repo/agent-server 智能体后端服务

Express 5 + LangChain 的智能体服务：对外提供账号鉴权、SSE 流式对话、会话持久化与向量知识库能力。

- 运行环境：Node ≥ 20（`type: module`，配置走 Node 原生 `--env-file` 加载）
- 技术栈：Express 5 + LangChain 1.x（`@langchain/ollama` / `@langchain/openai`）+ zod + mysql2
- 存储：MySQL 保存用户、登录会话与对话记录；知识库为本地 LanceDB 向量库
- 模型：默认本地 Ollama（`qwen3` + `nomic-embed-text`），可选切换 OpenAI 兼容的线上服务

仓库整体架构、统一命令与跨端约束见根 [README](../../README.md)；通用工具库见 [@repo/shared](../../packages/shared/README.md)，业务可复用库见 [@repo/reusable](../../packages/reusable/README.md)，日志库见 [@repo/logger](../../packages/logger/README.md)。

---

## 一、组合根与依赖装配

`src/index.ts` 是唯一的组合根：先读配置，`ensureSchema` 自动建库建表并创建连接池，随后依次创建 `UserStore` → `SessionStore` → `ConversationStore` → `KnowledgeStore` → `AgentService`，最后交给 `createApp` 组装并启动监听。`createApp` 只保留「通用中间件 → 注册路由 → 错误兜底」三段骨架，接口前缀与鉴权策略集中在 `routes/index.ts` 的 `registerRoutes` 声明，新增接口只需追加一行。所有依赖以参数显式注入（`AppDependencies`，定义于 `dependencies.ts`，避免路由反向依赖 `app.ts`），因此 `createApp` 可被单独引入做接口测试。

启动时还会执行 `sessionStore.prune()` 做一次会话清理（详见第三章），并把清理条数打进启动日志。

## 二、HTTP 接口与鉴权

| 方法     | 路径                              | 鉴权   | 说明                                                                                                        |
| -------- | --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/health`                     | 公开   | 健康检查，返回提供方、当前对话模型、知识库状态                                                              |
| `GET`    | `/api/health/ready`               | 公开   | 就绪检查：探测 MySQL / 模型 / 向量服务，附各档闸门水位与指标快照；任一依赖不可达返回 `degraded`（仍 `200`） |
| `GET`    | `/api/auth/public-key`            | 公开   | 取口令加密公钥（RSA-OAEP，JWK）；登录/注册/新建用户的 `password` 字段都须用它加密后提交，送明文一律 `400`   |
| `POST`   | `/api/auth/register`              | 公开   | 客户端注册并直接签发令牌，成功返回 `201`；角色固定为 `user`                                                 |
| `POST`   | `/api/auth/login`                 | 公开   | 客户端登录并签发令牌，凭证错误返回 `401`；后台侧账号一律 `401`（提示改用管理后台）                          |
| `POST`   | `/api/auth/logout`                | 需登录 | 删除当前令牌对应的会话，返回 `204`                                                                          |
| `GET`    | `/api/auth/me`                    | 需登录 | 用本地令牌换取当前用户信息，令牌失效返回 `401`                                                              |
| `POST`   | `/api/chat`                       | 需登录 | 流式对话（SSE），入参 `{ conversationId?, message }`                                                        |
| `GET`    | `/api/conversations`              | 需登录 | 当前账号的会话摘要列表（按更新时间倒序）                                                                    |
| `GET`    | `/api/conversations/:id`          | 需登录 | 会话详情（含全部消息），非本人会话返回 `404`                                                                |
| `DELETE` | `/api/conversations/:id`          | 需登录 | 删除会话（消息随外键级联删除）                                                                              |
| `POST`   | `/api/files`                      | 需登录 | 上传附件（multipart，字段名 `file`），按 magic bytes 判定类型并落盘，成功返回 `201` 与文件元数据            |
| `GET`    | `/api/files/:id/download`         | 需登录 | 按 ID 下载附件或智能体生成的导出文件，非本人文件返回 `404`                                                  |
| `GET`    | `/api/knowledge/documents`        | 需登录 | 可见文档列表（全局共享 + 本人私有）                                                                         |
| `POST`   | `/api/knowledge/documents`        | 需登录 | 新增私有文档（同步完成切分与向量化）                                                                        |
| `POST`   | `/api/knowledge/global/documents` | 需登录 | 新增全局共享文档，需带 `x-admin-token` 管理令牌                                                             |
| `DELETE` | `/api/knowledge/documents/:id`    | 需登录 | 删除文档及其全部片段；私有仅本人可删、全局仅管理员可删                                                      |

以上状态码统一取自 `@repo/reusable` 的 `HTTP_STATUS`，鉴权失效与内部错误等固定文案收在 `src/messages.ts` 的 `ERROR_MESSAGE`，代码里不再出现字面量数字与手抄的固定文案。

三个约定：

- **统一鉴权**：除 `/api/health` 与注册/登录外，其余路由都挂载 `requireAuth`；中间件从 `Authorization: Bearer <token>` 解析令牌，成功后将 `userId`/`token` 写入 **`res.locals`**（避免为扩展 `Express.Request` 引入全局类型声明），失败统一返回 `401 { message: '登录已失效，请重新登录' }`。
- **CORS 全放开**。桌面端在打包后可能以 `file://` 加载页面（Origin 为 `null`），因此统一返回 `Access-Control-Allow-Origin: *`，并在 `Access-Control-Allow-Headers` 中放行 `Authorization`。
- **兜底错误处理**。统一错误中间件透传 `error.status`（如 400/404），5xx 只把错误挂到 `res.locals` 交由请求日志统一记录（含堆栈），对外返回「服务内部错误」，避免异常导致连接悬挂。

### 管理端接口（`/api/admin/*`）

管理端走独立的 `requireAdmin`，入口在 `/api/admin` 下按模块再分一层：

| 方法     | 路径                                          | 说明                                                                                        |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST`   | `/api/admin/auth/login`                       | 后台登录（只接受 `super_admin` / `admin`；客户端账号回 `401` 并提示改用客户端）             |
| `GET`    | `/api/admin/stats`                            | 总览统计（用户规模、会话与消息量、近 7 天趋势、文档数）                                     |
| `GET`    | `/api/admin/health`                           | 运行状态（健康检查六项 + 运行时长 + MySQL 目标）                                            |
| `GET`    | `/api/admin/users`                            | 账号列表（用户名包含匹配 + 分页）；按调用者角色过滤，普通 admin 看不到后台账号              |
| `POST`   | `/api/admin/users`                            | 新建账号，成功 `201`；可授予的角色受调用者角色限制（admin 只能建客户端账号）                |
| `PATCH`  | `/api/admin/users/:id`                        | 变更角色或状态；admin 不可变更后台账号（按资源不存在回 `404`），也不可授予后台角色（`400`） |
| `DELETE` | `/api/admin/users/:id`                        | 删除账号（连带清理其会话、对话与上传文件），成功 `204`                                      |
| `POST`   | `/api/admin/users/batch-status`               | 批量停用 / 启用，回 `{ updated }`                                                           |
| `POST`   | `/api/admin/users/batch-delete`               | 批量删除账号，成功 `204`                                                                    |
| `GET`    | `/api/admin/knowledge/documents`              | 文档列表（管理视角，私有文档带归属账号名）                                                  |
| `POST`   | `/api/admin/knowledge/documents`              | 新增全局共享文档                                                                            |
| `DELETE` | `/api/admin/knowledge/documents/:id`          | 删除任意文档，成功 `204`                                                                    |
| `POST`   | `/api/admin/knowledge/documents/batch-delete` | 批量删除文档，成功 `204`                                                                    |
| `GET`    | `/api/admin/conversations`                    | 会话列表（全账号）                                                                          |
| `GET`    | `/api/admin/conversations/:id`                | 会话详情（含全部消息）                                                                      |
| `DELETE` | `/api/admin/conversations/:id`                | 删除任意会话，成功 `204`                                                                    |
| `POST`   | `/api/admin/conversations/batch-delete`       | 批量删除会话，成功 `204`                                                                    |
| `GET`    | `/api/admin/files`                            | 上传文件列表（全账号）                                                                      |
| `DELETE` | `/api/admin/files/:id`                        | 删除文件（元数据与落盘字节），成功 `204`                                                    |
| `POST`   | `/api/admin/files/batch-delete`               | 批量删除文件，成功 `204`                                                                    |
| `GET`    | `/api/admin/logs`                             | 接口日志（路径关键词 / 方法 / 状态档位 + 分页）                                             |
| `GET`    | `/api/admin/audit`                            | 操作审计（路径关键词 + 分页）                                                               |
| `GET`    | `/api/admin/system/tools`                     | LLM 工具清单（名称、用途、参数名）                                                          |
| `GET`    | `/api/admin/system/config`                    | 运行配置只读视图（密钥类只回是否已配置）                                                    |

**批量接口的语义**：一个请求处理一整批，不让前端循环调单条——自锁与「至少保留一名可登录管理员」是跨条目的判定，拆成 N 次单条请求就判不出来。用户类接口（停用 / 启用、删除）先整体预检再执行，任一项命中规则即**整批拒绝**并说明原因；文档 / 文件 / 会话的批量删除没有业务规则，按**幂等**处理（已不存在的条目视为已完成），因此不引入跨 Store 事务。`ids` 去重后不能为空，含非法项一律 `400`；用户类接口在目标已消失时回 `404`。取舍理由见 [ADR 0003](../../docs/adr/0003-batch-operation-semantics.md)。

**两条入口**：运维超级令牌（请求头 `x-admin-token`，与知识库全局文档写入共用同一枚 `KNOWLEDGE_ADMIN_TOKEN`，留空即关闭）与管理员会话（Bearer 令牌对应用户为**后台侧角色** `super_admin` 或 `admin` 且 `status=active`）。无令牌返回 `401`；已登录但权限不足按「资源不存在」返回 `404`，不向非管理员暴露管理接口的存在。两者的权限**只在用户管理模块**分级：超管可管理所有账号，普通 admin 只能操作客户端账号；其余模块的超管与 admin 权限相同，因此 `requireAdmin` 只判「是否后台侧」，差异下沉到 `routes/admin/users.ts` 内按调用者角色分支。`x-admin-token` 不绑定具体账号，权限**等价超管**——它是超管丢号或被误停时唯一的结构性后路，若只给 admin 权限，应急时照样管不了后台账号。

**中间件顺序**：管理端每个模块各自挂同一组 `adminGuard`（先 `requireAdmin`、再 `createAdminAudit`，只对 POST/PUT/PATCH/DELETE 记一笔审计）。守卫在注册表 `routes/index.ts` 里声明，新增管理接口不必再记得补记一笔；操作人从 `res.locals.admin` 取，鉴权没过就走不到这里。**更具体的路径必须登记在 `/api/admin`（总览）之前**：`app.use` 是前缀匹配，若总览排在前面，同一次请求会先跑一遍守卫、再落到具体模块，鉴权与审计都会重复一遍（回归用例见 `__vitest__/adminRoutes.test.ts`）。

## 三、账号与鉴权实现

**口令传输**：三处提交口（注册、登录、管理端新建用户）的 `password` 字段一律是**密文**——客户端先取 `GET /api/auth/public-key` 下发的 RSA 公钥，用 `RSA-OAEP` + SHA-256 加密后再提交；`auth/credentials.ts` 用私钥解密，**解不开即按参数非法返回 `400`，绝不回落成按明文比对**。密钥对在进程内生成、随重启轮换，不落盘也不进配置，客户端每次提交前重新取公钥，因此轮换无需失效处理。取舍见 [ADR 0004](../../docs/adr/0004-password-transport-and-storage.md)。

**密码存储**：`UserStore` 以 **`scrypt` + 16 字节随机盐**入库（格式 `scrypt$盐hex$散列hex`），不可逆；`authenticate` 对“用户不存在”与“密码错误”返回同一结果，由路由统一回以“用户名或密码错误”，不暴露账号是否已注册。注册走 `INSERT IGNORE`，命中 `username` 唯一索引时 `affectedRows = 0`，据此返回 `400`（用户名冲突归入“参数非法”：HTTP 约定只保留 400/401/404/500 四档错误码）。

**令牌与会话**：登录/注册成功后由 `SessionStore.create()` 签发 UUID 令牌并写入 `user_sessions`，有效期 7 天。会话策略为**单端登录**——每个账号同时只保留一条有效会话，新登录顶掉旧会话：

```text
create()  ：同一事务内 DELETE 该 user 的全部旧会话 → INSERT 新令牌
            （放同一事务是为了避免中途失败时旧令牌已失效、新令牌又没落库）
resolve() ：按 token 查询；已过期则顺手删除并返回 null
prune()   ：启动时清理过期会话，并把历史遗留的同账号重复会话收敛为“仅保留最新一条”
```

> `prune()` 里的去重是一段自连接删除：保留每个账号 `created_at` 最新的一行（时间相同时用 `token` 兜底比较，保证结果确定）。这段逻辑是为收敛早期版本“每次登录都 INSERT 而不清理”留下的重复数据而加的。

**账号与端隔离**：`role` 分三级 `super_admin` / `admin` / `user`，代码以常量 `ADMIN_ROLES = ['super_admin', 'admin']` 表达「后台侧」。一个账号只属于一端，**端由登录路径承载**：客户端 `POST /api/auth/login` 只接受 `role='user'`，后台侧账号即便口令正确也回 `401 { message: '该账号不能登录客户端，请使用管理后台' }`；后台 `POST /api/admin/auth/login` 只接受后台侧角色，客户端账号回 `401 { message: '该账号不能登录管理后台，请使用客户端' }`。口令错误或账号不存在仍是含糊的 `401 { message: '用户名或密码错误' }`——不暴露账号是否注册；口令已通过、只是端不匹配时才明确告知，因为此时对方已证明自己持有该账号。之所以按端拆入口而不是让调用方传字段自证身份，是为了从根上消除「同账号两端互顶」：`SessionStore.create()` 的单端语义保持不变，但同一个账号已不可能同时出现在两端。客户端注册 `POST /api/auth/register` 固定产出 `role='user'`，后台不设注册入口，后台账号只能由超管在用户管理里创建。公钥仍是两端共用的 `GET /api/auth/public-key`（后台前端也用这个地址取公钥）。

**超管自举**：启动时读环境变量 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`，**仅当库中不存在任何后台侧账号时**创建；已存在则跳过、不覆盖，未配置凭据时启动告警而非静默跳过。因此上线顺序必须是「先配环境变量、再上代码」——否则代码先上而 env 未配，空库启动会因无凭据跳过自举，系统仍进不去后台。数据迁移上，`users.role` 的 `ENUM` 由两值扩为三值在 MySQL 里是**重建表**（上线前需备份），存量 `admin` 账号会被迁移为 `super_admin`；迁移幂等，判据写在列定义里是否已含 `super_admin`，避免后续启动把新模型下刻意保留的普通 admin 误提权。

## 四、数据表设计

`ensureSchema` 在启动时先以**不指定 database** 的连接 `CREATE DATABASE IF NOT EXISTS`，再连到该库执行建表（全部 `IF NOT EXISTS`，可重复执行）。七张表统一 `utf8mb4` / InnoDB：

| 表              | 关键字段                                                                                                                      | 说明                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `users`         | `id` 主键、`username` 唯一、`password`（`scrypt$盐hex$散列hex`）、`role`（`ENUM('super_admin','admin','user')`，默认 `user`） | 账号表；`role` 表达账号归属哪一端：`user` 为客户端，`super_admin` / `admin` 为后台侧 |
| `user_sessions` | `token` 主键、`user_id` 索引、`expires_at`                                                                                    | 登录会话表，单端登录下每个账号至多一行                                               |
| `conversations` | `id` 主键、`user_id`、`title`、`updated_at`（`(user_id, updated_at DESC)` 索引）                                              | 对话表，列表查询走该复合索引                                                         |
| `messages`      | `id` 主键、`seq` 自增唯一、`conversation_id` 外键（`ON DELETE CASCADE`）                                                      | 消息表，`seq` 保证读取顺序稳定，删会话即级联清消息                                   |
| `files`         | `id` 主键、`user_id`、`name`（原始文件名，仅作展示）、`ext` / `mime`（由 magic bytes 判定）、`size`、`created_at`             | 上传文件元数据表；原始字节落在 `<UPLOAD_DIR>/<userId>/<fileId>.<ext>`，不进数据库    |
| `api_logs`      | `id` 自增主键、`request_id`（8 位）、`method` / `path` / `status` / `duration_ms`、`user_id` 可空、摘要三列、`created_at`     | 接口请求日志表，由请求日志中间件在响应结束时落库；`user_id` 为 NULL 表示未登录入口   |
| `audit_logs`    | `id` 自增主键、`actor_id` 可空、`method` / `path` / `status`、`detail`（请求体摘要）、`created_at`                            | 管理端写操作审计表，由审计中间件在写操作结束时落库；超级令牌入口 `actor_id` 为 NULL  |

> 之所以用自增 `seq` 而非 `created_at` 排序：同一毫秒内写入的多条消息时间戳可能相同，`seq` 能提供严格稳定的顺序。

## 五、SSE 流式协议

`POST /api/chat` 的响应为 `text/event-stream`，每个事件都是 `data: <JSON>\n\n`，共七种：

| 事件           | 载荷                              | 触发时机                                                     |
| -------------- | --------------------------------- | ------------------------------------------------------------ |
| `conversation` | `{ type, conversationId }`        | 首个产出之前补推：这条会话确定会被保留                       |
| `token`        | `{ type, content }`               | 模型输出增量文本                                             |
| `tool`         | `{ type, name, status }`          | 工具开始（`start`）/ 结束（`end`）                           |
| `source`       | `{ type, name }`                  | 检索工具结束时增量推送命中的知识库文档名，客户端据此标注来源 |
| `file`         | `{ type, fileId, name, size }`    | `write_file` 产出文件后于流末尾统一推送，客户端据此提供下载  |
| `done`         | `{ type, conversationId, title }` | 答复落库完成，本轮结束                                       |
| `error`        | `{ type, message }`               | 推理过程异常                                                 |

中断处理是这段实现里最关键的一处细节：客户端关闭连接时必须立刻停下模型推理。实现上监听的是 `res` 而非 `req`——`req` 的 `close` 在请求体读取完成后就会触发，会误中断正常的流式响应；同时用 `res.writableEnded` 排除“正常结束”这一次回调，只有真正的提前断开才 `controller.abort()`。此外，仅在答复正文非空时落库，避免保存空回复；中断或出错时也会把已产出的部分回复落库，用户已经看到的内容不会在重开会话后消失。

这一整轮编排都在 `services/chatStream.ts` 的 `streamChatReply()` 中（落库提问 → 流式写回 → 落库回复 → 回滚没有产出的新建会话），`routes/client/chat.ts` 只保留入参校验（400）与会话归属校验（404），路由与流式协议解耦。落库提问刻意放在 `flushHeaders()` 之前，这样落库失败仍能按普通请求返回 500，而不是已经 flush 的事件流。事件本身的结构声明在 `@repo/reusable` 的 `ChatStreamEvent`，服务端与桌面端共用同一份，避免两端各抄一份而漂移。

新建会话若本轮既未正常收尾、也没有任何产出（模型服务未启动、刚发出就被停止），该会话只剩刚写入的提问，服务会连会话一起删除——否则列表里会留下一条没有回答的记录，用户重新发起对话后就会看到两条。反过来，已经开始产出内容的会话即便被中断（用户点“停止”）也保留，不丢用户刚发出的输入，且服务端在首个产出之前就补推了 `conversation` 事件，客户端从此刻起已知道会话 ID，中断后仍能接着这条会话继续发；已推送 `done` 的会话（含模型返回空内容的情形）同样保留，避免前端已记住的 `conversationId` 失效。

## 六、智能体（AgentService）

采用 LangChain 的 `createAgent({ model, tools, systemPrompt })` 构建 ReAct 风格智能体，并以 `streamMode: 'messages'` 消费流——该模式能同时拿到文本增量与工具调用分片，是“边想边答 + 展示工具轨迹”的基础。

流桥接做了两件必要的适配：

- `AIMessageChunk.content` 可能是字符串，也可能是内容块数组，用 `extractText` 统一抽取纯文本；
- 一次工具调用会分散在多个分片中，用 `startedTools: Set` 去重，保证 `start` 事件只推送一次。

`system prompt` 是保证回答质量的核心约束（原文见 `llm/prompt.ts`）：

1. 需要事实信息时优先调用工具，不要凭空编造；
2. **涉及公司制度、业务流程、产品资料、内部规定、专有知识，或带有“知识库/文档/资料”字样时，必须先调用 `search_knowledge_base` 检索后再作答**，禁止凭记忆直接回答，检索为空时才说明“知识库中未找到相关内容”；
3. 涉及“今天/现在”等时间概念时调用 `get_current_time`；
4. 涉及算术运算时调用 `calculator`，不要心算；
5. 引用知识库内容时标注来源文档名称；
6. 本轮对话附带文件时，附件内容已随消息预先给出，必须直接据此回答，不要凭文件名或常识猜测；需要复核原文或内容缺失时才调用 `read_file`，读不到就如实说明；
7. 需要把结果整理成文件交给用户（导出、转换格式、另存一份）时调用 `write_file`；正文必须写完整，不要用“同上”“略”之类的省略，也不要在回答里重复整篇文件内容；
8. 使用简体中文回答，条理清晰，必要时使用列表。

> 约束 2 是必需的：本地小模型在无强制要求时倾向于直接作答而不检索，这条规则把它拉回“先查后答”的链路。

### 上下文治理

历史此前是**全量**注入模型，长会话必然溢出窗口。现在每轮由 `src/llm/context/` 组装：先按字符构成估算整段历史的 token（非 ASCII 约每字符 1 个、ASCII 约每 4 字符 1 个），超过窗口 `CONTEXT_TRIGGER_RATIO` 才把保留窗口收窄到 `CONTEXT_KEEP_RATIO`，并**从新到旧整轮丢弃**——保证 `user` / `assistant` 成对，最新一轮（本轮提问）无条件保留；未触发时行为与治理前完全一致。本轮注入的估算量、丢弃条数、生效预算与是否产出新摘要记在「本轮对话完成」日志的 `estimatedContextSize` / `trimmedMessages` / `windowBudget` / `summarized` 四个字段里。

阶段 3 起，「丢弃」不再是超限时的第一选择：触发治理时先把**保留窗口起点之前的全部未摘要段**交给对话模型，与已有摘要合并成一段新摘要后落库（`conversations.summary` / `summary_upto_seq`），再以一条 `SystemMessage` 注入到历史之前。截断点用消息自增列 `seq` 记录，恰好推进到被挤出段的末条，与保留窗口紧贴衔接，既不漏段也不重复占位。摘要请求复用对话模型实例单次 `invoke`（不走 agent、不带工具），输出限长后计入窗口估算，防止误差随轮次累积；摘要失败或产出为空时**不推进截断点**，本轮退化为上面的确定性丢弃，下轮重新尝试。写入用条件更新（`summary_upto_seq < ?`）保证截断点只增不减，并发下先落库的一次生效。摘要是锦上添花，任何时候都不阻断对话，整体取舍见 [ADR 0008](../../docs/adr/0008-context-window-and-summary.md)。裁剪**真正发生**时，服务端会在首个 token 之前补推一条 `context` 事件（`trimmedMessages` + `summarized`），客户端据此提示「这轮回答没看到完整历史」；未触发裁剪就不推，避免每轮都挂一条无意义提示。该事件不落库，历史回看时不还原。

历史之外，一轮之内的**工具结果**与**附件预读**同样会挤占窗口：模型可能反复检索、反复读同一批文件，一份超长附件也能把窗口挤爆。阶段 2 给单轮注入的这些产物加了一道额度（`CONTEXT_TOOL_RATIO`，占窗口的比例），由 `src/llm/context/budget.ts` 的 `createToolBudget()` 承载，附件预读、检索与读取共用同一份额度、跨同轮多次调用累计。规则有两条：

- **按文档去重**：同一份知识库文档在本轮只回填一次，后续检索再次命中时不再重复注入片段，只提示「已在此前给出」；
- **超额度即截断**：额度用尽后不再注入新内容，被截断的结果会附一句「已达上下文预算上限」的说明，让模型知道自己没看到全部内容；附件预读超出额度时保留「【文件名｜ID】」抬头行，只是正文不再注入。

额度按 `windowTokens × toolRatio` 折算，因此本地与线上模型各有合适的档位，不必分别配绝对数。本轮注入产物的用量由 `AgentService` 在流结束时记一条 debug 日志（`usedBudget` / `budgetLimit` / `deliveredDocuments`），可据此判断本轮是否被检索或读取挤占。

## 七、工具层

| 工具                    | 参数                                                               | 说明                                                                                                   |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `search_knowledge_base` | `query: string`                                                    | 按当前用户可见性检索知识库，命中后以「【片段 n】来源《标题》」格式回填；同轮已回填过的文档不再重复注入 |
| `list_files`            | 无                                                                 | 列出本轮附件的 `ID｜文件名｜扩展名｜大小`                                                              |
| `read_file`             | `fileId: string`                                                   | 复核附件原文（优先用预读内容）：docx / xlsx / pdf 走解析器，图片交给视觉模型转述                       |
| `write_file`            | `name: string` / `format: docx \| xlsx \| pdf` / `content: string` | 按指定格式生成导出文件，登记到本轮导出收集器                                                           |
| `get_current_time`      | 无                                                                 | 返回 `Asia/Shanghai` 时区的当前时间                                                                    |
| `calculator`            | `expression: string`                                               | 计算 `+ - * / ( )` 算术表达式                                                                          |

工具参数全部用 **zod schema** 声明，由框架负责校验与描述注入。

`write_file` 产出的文件由流末尾的 `file` 事件推给客户端；`read_file` 只允许读本轮附件（名单经 `configurable.fileIds` 注入，模型编造的 ID 读不到），单次读取正文超过 8000 字会截断并说明。`search_knowledge_base` 命中的文档名则在工具结束时由 `source` 事件增量推出（同一文档多次命中只出一个标签），来源标签因此由服务端确定地给出——提示词早就要求「引用知识库内容必须标注来源」，但指望小模型在正文里照抄出处会漏标。

**附件在作答前被预读**：`AgentService.appendAttachments` 对 `fileIds` 逐个调用 `readAttachmentText`（图片走视觉模型、其余走解析器），把结果以 `SystemMessage` 追加到对话末尾，模型不必自行决定是否调用 `read_file`。原因是实测同一张图在「我上传了一张图片…」这类强措辞下能触发读取，换成「图片里是什么」则连续 6 轮一次都不读、直接编造答案——小模型对工具调用指令的遵循率撑不起主链路。`read_file` 因此退为复核手段，仍予保留；单个附件读不到（文件失效、视觉模型不可用）只如实注明，不中断整轮对话。

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
- 向量化失败（如本地 embedding 服务未启动）时接口返回 **500**（依赖失败一律 500；503 是并发闸门在硬水位处签发的过载拒绝专用码，不在此列）与可读的失败原因（提示中带上当前向量化服务地址，便于区分“服务未启动”与“模型或维度不符”）；
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

| 变量                                                           | 默认值                      | 说明                                                                      |
| -------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `PORT`                                                         | `3000`                      | 服务端口                                                                  |
| `DATA_DIR`                                                     | `<cwd>/data`                | 数据目录（知识库与日志的基准目录）                                        |
| `LOG_LEVEL`                                                    | `info`                      | 日志级别：`debug` / `info` / `warn` / `error`                             |
| `LOG_DIR`                                                      | `<数据目录>/logs`           | 日志目录（相对路径会随启动目录漂移，建议填绝对路径）                      |
| `LOG_RETENTION_DAYS`                                           | `14`                        | 日志文件保留天数                                                          |
| `MYSQL_HOST`                                                   | `127.0.0.1`                 | MySQL 地址                                                                |
| `MYSQL_PORT`                                                   | `3306`                      | MySQL 端口                                                                |
| `MYSQL_USER`                                                   | `root`                      | MySQL 用户名                                                              |
| `MYSQL_PASSWORD`                                               | 空                          | MySQL 密码（默认留空，部署时注入，见第十一章）                            |
| `MYSQL_DATABASE`                                               | `agent_data`                | 库名（不存在时自动创建）                                                  |
| `MYSQL_QUEUE_LIMIT`                                            | `32`                        | 池满后的等待队列长度上限（`0` 表示不排队，池满即失败）                    |
| `MYSQL_CONNECT_TIMEOUT_MS`                                     | `10000`                     | 建连超时（毫秒），MySQL 不可达时尽快失败                                  |
| `LLM_PROVIDER`                                                 | `ollama`                    | `ollama` 或 `deepseek`                                                    |
| `LLM_TEMPERATURE`                                              | `0.3`                       | 采样温度                                                                  |
| `LLM_THINKING`                                                 | `false`                     | 是否输出推理链（thinking）：仅对 Ollama 生效，且需模型自身支持            |
| `OLLAMA_BASE_URL`                                              | `http://127.0.0.1:11434`    | Ollama 地址                                                               |
| `OLLAMA_CHAT_MODEL`                                            | `qwen3`                     | 本地对话模型                                                              |
| `OLLAMA_EMBEDDING_MODEL`                                       | `nomic-embed-text`          | 本地向量模型                                                              |
| `DEEPSEEK_API_KEY`                                             | 空                          | 线上对话服务的密钥                                                        |
| `DEEPSEEK_BASE_URL`                                            | `https://api.deepseek.com`  | DeepSeek 兼容 OpenAI 协议                                                 |
| `DEEPSEEK_CHAT_MODEL`                                          | `deepseek-chat`             | 线上对话模型                                                              |
| `OLLAMA_CONTEXT_WINDOW_TOKENS`                                 | `8192`                      | 本地对话模型的窗口预算（token），需与 Ollama 的 `num_ctx` 对齐            |
| `DEEPSEEK_CONTEXT_WINDOW_TOKENS`                               | `65536`                     | 线上对话模型的窗口预算（token）                                           |
| `CONTEXT_TRIGGER_RATIO`                                        | `0.7`                       | 上下文占用超过窗口该比例时触发裁剪                                        |
| `CONTEXT_KEEP_RATIO`                                           | `0.4`                       | 触发裁剪后保留的窗口占比                                                  |
| `CONTEXT_TOOL_RATIO`                                           | `0.3`                       | 单轮附件预读、检索、读取结果合计可注入的窗口占比，超出即截断              |
| `EMBEDDING_PROVIDER`                                           | `ollama`                    | `ollama` 或 `openai`                                                      |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` | `text-embedding-3-small` 等 | 线上向量服务配置                                                          |
| `KNOWLEDGE_CHUNK_SIZE`                                         | `500`                       | 切片长度                                                                  |
| `KNOWLEDGE_CHUNK_OVERLAP`                                      | `80`                        | 切片重叠                                                                  |
| `KNOWLEDGE_TOP_K`                                              | `4`                         | 检索返回片段数                                                            |
| `KNOWLEDGE_MIN_SCORE`                                          | `0.6`                       | 检索相似度下限（低于该分数的片段丢弃）                                    |
| `KNOWLEDGE_ADMIN_TOKEN`                                        | 空                          | 全局知识库管理令牌（留空即关闭全局写入），权限等价超管                    |
| `INITIAL_ADMIN_USERNAME`                                       | 空                          | 初始超管用户名，仅当库中不存在任何后台侧账号时用于启动自举（见第三章）    |
| `INITIAL_ADMIN_PASSWORD`                                       | 空                          | 初始超管密码，同上两个变量须成对配置；未配置凭据时启动告警                |
| `OLLAMA_VISION_MODEL`                                          | `qwen3-vl:8b`               | 图片理解用的本地多模态模型（**留空即关闭图片理解**）                      |
| `UPLOAD_MAX_BYTES`                                             | `20971520`                  | 上传单文件字节上限                                                        |
| `UPLOAD_MAX_FILES`                                             | `1`                         | 单请求文件数上限                                                          |
| `UPLOAD_ALLOWED_TYPES`                                         | `docx,xlsx,pdf,png,jpg`     | 允许的扩展名白名单，与 magic bytes 判定结果比对                           |
| `UPLOAD_DIR`                                                   | `<数据目录>/uploads`        | 上传文件落盘根目录                                                        |
| `HTTP_HEADERS_TIMEOUT_MS`                                      | `20000`                     | 请求头接收超时（毫秒）                                                    |
| `HTTP_REQUEST_TIMEOUT_MS`                                      | `120000`                    | 整个请求（头 + 体）接收超时（毫秒），SSE 响应期不受它约束                 |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS`                                   | `65000`                     | keep-alive 空闲连接保持时长（毫秒）                                       |
| `HTTP_MAX_REQUESTS_PER_SOCKET`                                 | `1000`                      | 单条连接可复用的最大请求数（`0` 表示不限）                                |
| `CONCURRENCY_CHAT_MAX_IN_FLIGHT`                               | `8`                         | 对话流档硬水位（在途上限），达到即拒绝                                    |
| `CONCURRENCY_CHAT_SOFT_LIMIT`                                  | `6`                         | 对话流档软水位，超过即进入有界队列等待                                    |
| `CONCURRENCY_CHAT_QUEUE_LIMIT`                                 | `32`                        | 对话流档排队长度上限                                                      |
| `CONCURRENCY_CHAT_QUEUE_TIMEOUT_MS`                            | `20000`                     | 对话流档排队等待上限（毫秒），超时即拒绝                                  |
| `CONCURRENCY_UPLOAD_MAX_IN_FLIGHT`                             | `2`                         | 上传解析档硬水位（在途上限）                                              |
| `CONCURRENCY_UPLOAD_SOFT_LIMIT`                                | `1`                         | 上传解析档软水位                                                          |
| `CONCURRENCY_UPLOAD_QUEUE_LIMIT`                               | `8`                         | 上传解析档排队长度上限                                                    |
| `CONCURRENCY_UPLOAD_QUEUE_TIMEOUT_MS`                          | `10000`                     | 上传解析档排队等待上限（毫秒）                                            |
| `CONCURRENCY_CRUD_MAX_IN_FLIGHT`                               | `32`                        | 普通读写档硬水位（在途上限）                                              |
| `CONCURRENCY_CRUD_SOFT_LIMIT`                                  | `24`                        | 普通读写档软水位                                                          |
| `CONCURRENCY_CRUD_QUEUE_LIMIT`                                 | `64`                        | 普通读写档排队长度上限                                                    |
| `CONCURRENCY_CRUD_QUEUE_TIMEOUT_MS`                            | `5000`                      | 普通读写档排队等待上限（毫秒）                                            |
| `CHAT_MAX_DURATION_MS`                                         | `180000`                    | 单轮对话最长时长（毫秒），到点中断并按已产出收尾                          |
| `SSE_DRAIN_TIMEOUT_MS`                                         | `30000`                     | SSE 背压：写缓冲满后等待 `drain` 的上限（毫秒），超时按慢客户端断开       |
| `SHUTDOWN_GRACE_MS`                                            | `15000`                     | 优雅停机：停止接单后等待在途请求收尾的上限（毫秒）                        |
| `API_LOG_BATCH_SIZE`                                           | `50`                        | 接口日志批量刷写：缓冲攒到该条数即落库                                    |
| `API_LOG_FLUSH_INTERVAL_MS`                                    | `1000`                      | 接口日志批量刷写：未攒够一批时的定时刷写间隔（毫秒），停机时会落尽        |
| `AUTH_SESSION_CACHE_TTL_MS`                                    | `5000`                      | 鉴权令牌校验结果的缓存有效期（毫秒），登出 / 重登 / 删号会主动失效        |
| `CONCURRENCY_MODEL_MAX_IN_FLIGHT`                              | `8` / `2`                   | 模型闸门硬水位（在途上限），默认 DeepSeek `8`、Ollama `2`（决策 9）       |
| `CONCURRENCY_MODEL_SOFT_LIMIT`                                 | `6` / `1`                   | 模型闸门软水位，超过即进入有界队列                                        |
| `CONCURRENCY_MODEL_QUEUE_LIMIT`                                | `32` / `8`                  | 模型闸门排队长度上限                                                      |
| `CONCURRENCY_MODEL_QUEUE_TIMEOUT_MS`                           | `20000`                     | 模型闸门排队等待上限（毫秒），超时按过载拒绝                              |
| `CONCURRENCY_SUMMARY_MAX_IN_FLIGHT`                            | `1`                         | 滚动摘要闸门硬水位：独立低优先队列，不占对话额度（决策 10）               |
| `CONCURRENCY_SUMMARY_SOFT_LIMIT`                               | `1`                         | 滚动摘要闸门软水位                                                        |
| `CONCURRENCY_SUMMARY_QUEUE_LIMIT`                              | `0`                         | 滚动摘要闸门队列长度上限（`0` 表示不排队，满即拒绝后降级）                |
| `CONCURRENCY_SUMMARY_QUEUE_TIMEOUT_MS`                         | `3000`                      | 滚动摘要闸门排队等待上限（毫秒）                                          |
| `CONCURRENCY_RETRIEVAL_MAX_IN_FLIGHT`                          | `4`                         | 检索与向量化闸门硬水位：读路径过它，写入路径不占（决策 11）               |
| `CONCURRENCY_RETRIEVAL_SOFT_LIMIT`                             | `2`                         | 检索闸门软水位                                                            |
| `CONCURRENCY_RETRIEVAL_QUEUE_LIMIT`                            | `8`                         | 检索闸门排队长度上限                                                      |
| `CONCURRENCY_RETRIEVAL_QUEUE_TIMEOUT_MS`                       | `3000`                      | 检索闸门排队等待上限（毫秒）                                              |
| `RETRIEVAL_TIMEOUT_MS`                                         | `8000`                      | 单次检索（含向量化）超时（毫秒），超时降级为「本轮无知识库结果」          |
| `CIRCUIT_FAILURE_THRESHOLD`                                    | `5`                         | 依赖熔断：连续失败达该值即快速失败（决策 16）                             |
| `CIRCUIT_COOLDOWN_MS`                                          | `30000`                     | 依赖熔断：打开后冷却多久再放一个探测（毫秒）                              |
| `CONCURRENCY_PARSE_MAX_IN_FLIGHT`                              | `2`                         | 附件解析闸门硬水位：解析是主线程 CPU 密集计算，独占小额度（决策 14）      |
| `CONCURRENCY_PARSE_SOFT_LIMIT`                                 | `1`                         | 附件解析闸门软水位                                                        |
| `CONCURRENCY_PARSE_QUEUE_LIMIT`                                | `8`                         | 附件解析闸门排队长度上限                                                  |
| `CONCURRENCY_PARSE_QUEUE_TIMEOUT_MS`                           | `5000`                      | 附件解析闸门排队等待上限（毫秒）                                          |
| `OBSERVABILITY_EVENT_LOOP_SAMPLE_INTERVAL_MS`                  | `10000`                     | 事件循环延迟采样间隔（毫秒），越短越能捕捉短时阻塞（决策 17）             |
| `OBSERVABILITY_HISTOGRAM_SIZE`                                 | `1024`                      | 指标直方图保留的最近样本数，分位数基于该窗口计算                          |
| `READINESS_PROBE_TIMEOUT_MS`                                   | `3000`                      | `/api/health/ready` 探测单个依赖（MySQL / 模型 / 向量服务）的超时（毫秒） |

并发闸门是**进程内状态**：进程重启即清零，多实例下各算各的，不能当作全局配额（见 [ADR 0010](../../docs/adr/0010-concurrency-governance.md)）。过载时返回 `503` 并附 `Retry-After`；健康检查与登录接口不挂闸门，过载时仍可观测、仍能进后台。默认阈值只保证不雪崩，吞吐基线须按容量模型压测后校准。

对话模型与向量模型**分开配置**：DeepSeek 不提供 embedding 接口，所以即便对话走线上，向量仍可继续使用本地 Ollama。

### 日志

日志能力来自公共包 [@repo/logger](../../packages/logger/README.md)，同时输出到控制台与 `<LOG_DIR>/agent-server-YYYY-MM-DD.log`（文件名前缀取自 `createLogger({ name: 'agent-server' })`）：按本地日期轮转，超期文件在启动与跨天时清理，且只清理自己前缀的文件；日志文件写入失败（目录无权限、磁盘满）只降级为"仅控制台输出"，不影响服务本身。控制台里 `warn` / `error` 走 stderr，可用 `2>` 单独重定向。

每个请求都会分配一个 8 位 `requestId`：它出现在该请求产生的每条日志上，并通过响应头 `x-request-id` 回写。排查时先按 `requestId` 检索日志文件，即可拿到该请求的完整链路（请求汇总、业务动作、5xx 的原始堆栈）。

日志中的密码、令牌、密钥字段（`password` / `token` / `authorization` / `apiKey` 等）在写入前已统一遮蔽为 `***`。

知识库检索的命中片段数与最高相似度记在 `debug` 级别，排查"答非所问 / 未命中"时把 `LOG_LEVEL` 调为 `debug` 即可看到。

请求级日志同时记录**入参**（查询串、请求体）与**出参**（JSON 响应体）：两者都先脱敏再截断到 500 字符，长度超过 100 字符的字段会折叠成缩进块单独成行，因此首行的「时间 + 接口路径 + 事件 + 短字段」始终便于扫读。流式接口 `/api/chat` 不走 JSON 响应，其出参以 `answerLength` 与 `answerPreview`（回复开头 200 字符）记录，另有 `tools` 与 `sources` 分别列出本轮用到的工具与检索命中的知识库文档。

### 容量基线与 SLO

并发闸门的默认水位「只保证不雪崩」，真实容量由压测校准（见 [ADR 0010](../../docs/adr/0010-concurrency-governance.md) 决策 17）。两件套配合使用：

```bash
# 1) 起不调真实模型的 mock 服务（OpenAI 兼容），让压测聚焦服务端编排而非模型算力
pnpm --filter @repo/agent-server run mock:model
# 2) 让后端指向 mock（覆盖模型与向量两处配置），再按需启动后端
LLM_PROVIDER=deepseek DEEPSEEK_BASE_URL=http://127.0.0.1:8901 DEEPSEEK_API_KEY=mock \
EMBEDDING_PROVIDER=openai EMBEDDING_BASE_URL=http://127.0.0.1:8901 EMBEDDING_API_KEY=mock \
pnpm --filter @repo/agent-server run dev
# 3) 施压并判定 SLO（未给令牌时用 BENCH_USERNAME / BENCH_PASSWORD 换一枚）
BENCH_TOKEN=<登录令牌> pnpm --filter @repo/agent-server run bench
```

压测在客户端侧采集四项口径：**首 token P95**（从发起到收首个 `token` 事件，贴近用户感知）、**整轮 P95**、**503 比例**（闸门硬水位拒绝），以及从 `/api/health/ready` 读回的**连接池等待 P95**（`pool.waitMs` 分位数）。四项各有默认目标值，任一未达标脚本以非零退出码收尾；目标可用 `SLO_FIRST_CHUNK_P95_MS` / `SLO_ROUND_P95_MS` / `SLO_MAX_503_RATIO` / `SLO_POOL_WAIT_P95_MS` 覆盖。

| 口径         | 默认目标  | 说明                                           |
| ------------ | --------- | ---------------------------------------------- |
| 首 token P95 | `1500ms`  | mock 基线；接真实模型后需按实测重新标定        |
| 整轮 P95     | `15000ms` | 含工具往返与全文产出                           |
| 503 比例     | `1%`      | 硬水位拒绝占比，超出说明水位定得过紧或容量不足 |
| 池等待 P95   | `50ms`    | `pool.waitMs`；偏高说明 MySQL 连接池偏小       |

这些默认值是 **mock 基线**，不是生产承诺：mock 省去了模型与向量服务的真实耗时，因此接到真实模型、真实向量服务后，必须重跑压测把水位与目标一起重新标定。

## 十一、前置条件与启动

依赖 Node.js ≥ 20、pnpm ≥ 9、本地 **MySQL 8**（默认 `127.0.0.1:3306`，账号 `root`，密码由 `.env.development` 提供、可用环境变量覆盖，见第十章），以及本地 Ollama：

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p   # 验证 MySQL 可连接（库表会在后端启动时自动创建）

ollama pull qwen3          # 对话模型（必须支持工具调用）
ollama pull nomic-embed-text    # 向量模型
ollama pull qwen3-vl:8b         # 图片理解（可选；把 OLLAMA_VISION_MODEL 留空即关闭）
ollama serve
```

> 对话模型必须选择**支持 Function Calling** 的版本。例如 `deepseek-r1:7b` 不支持 Ollama 的函数调用，会导致模型不调用工具、直接编造答案；`qwen3` 可正常使用。

首次部署还需先在 `.env.production`（或系统环境变量）里配好 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`，顺序是**先配变量、再上代码**：代码先上而变量缺失时，空库启动会因无凭据跳过超管自举（仅告警），后台将无人可登。

单独启动后端（默认 3000 端口，`tsx watch`）：

```bash
pnpm --filter @repo/agent-server run dev
```

## 十二、构建与运行

- `pnpm --filter @repo/agent-server run build`：先 `tsc --noEmit` 做类型检查，再由 `vite build` 把 `src/index.ts` 打成单文件 `dist/index.js`（ESM + sourcemap，代码部分已压缩、不含空格与注释）；
- Vite 走服务端构建（`build.ssr`，`target: node20`），按 Node 环境解析依赖；目录下的 `.env.*` 由 `node --env-file` 在运行时读取，构建时以 `envDir: false` 关闭 Vite 自身的 env 加载；
- 运行期依赖（含 workspace 的 `@repo/shared`、`@repo/reusable`、`@repo/logger`）与 Node 内置模块全部外置，产物中保留裸包名，部署时需一并安装 `dependencies`；
- 启动：`pnpm --filter @repo/agent-server run start`，即 `node --env-file=.env.production dist/index.js`。
- 产物中仍可见的换行与缩进都属于字符串内容（多行 SQL、系统提示词、SSE 报文的 `\n\n`），是数据而非格式：`\n\n` 是 SSE 协议分隔符，提示词换行影响模型输入，压缩器不会也不应改写它们。

## 十三、已知约束与设计取舍

- **会话已改为 MySQL 持久化**：会话与消息按 `user_id` 隔离存储，天然支持多账号与并发访问；代价是 `append` 一次要写两张表（插入消息 + 更新会话时间），消息量极大时可考虑批量提交或异步刷写。
- **登录为单端登录**：每个账号同时只有一条有效会话，新登录顶掉旧会话；这保证了 `user_sessions` 不会累积重复行，但也意味着同账号无法多端同时在线。
- **账号与端绑定**：一个账号只属于一端（客户端或后台），登录入口按端拆成两条路径并在口令通过后校验角色，因此「同账号两端互顶」从根上消失；但**同一端**的多处登录仍会互顶（如超管在两台电脑登录后台），这是刻意保留的单端语义。取舍见 [ADR 0006](../../docs/adr/0006-account-isolation-and-admin-hierarchy.md)。
- **system prompt 强约束检索**：以“必须检索后才回答”换取准确率，代价是知识库类问题必然会多一次工具往返。
- **知识库检索为暴力近邻**：LanceDB 表内逐个算 cosine 相似度再排序，简单可靠，适合中小规模语料；数据量增长后需补建 ANN 索引。
