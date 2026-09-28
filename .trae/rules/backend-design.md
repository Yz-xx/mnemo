---
description: apps/agent-server 的设计规范，涵盖分层结构与依赖方向、组合根与依赖注入、路由与鉴权、SSE 流式对话协议、MySQL 数据层与错误码约定。新增或修改后端接口、服务、数据层与中间件时遵守。
globs: apps/agent-server/**
alwaysApply: false
---

# 后端设计规范

## 1. 分层与依赖方向

```text
apps/agent-server/src/
├── index.ts          组合根：读配置 → 建库表 → 建连接池 → 装配 Store/Service → createApp → listen
├── app.ts            createApp：仅"通用中间件 → 注册路由 → 错误兜底"三段骨架
├── configuration/    config/（env 读取、默认值与运行视图）、dependencies.ts、errors.ts、messages.ts
├── middleware/       cors.ts、requestLog.ts、adminAudit.ts、upload.ts、errorHandler.ts
├── routes/           client/ 客户端接口、admin/ 管理端接口；index.ts 注册前缀与鉴权，pagination.ts 为共用工具
├── services/         跨路由的编排逻辑（chatStream.ts、knowledge.ts、adminUsers.ts、health.ts）
├── auth/             userStore / sessionStore / middleware / credentials
├── conversation/     会话与消息持久化；store/ 下按关注点分文件
├── llm/              agent、model、prompt、vision；tools/ 下按关注点分文件
├── rag/              知识库存储与检索，按关注点分文件
├── files/            附件解析、导出与存储
├── audit/ logging/   操作审计与接口日志存储
├── db/               pool.ts、schema.ts
└── __vitest__/       单元测试（不参与编译产物）
```

- 依赖方向单向：`routes → services → store/llm/db`，下层不得反向 import 上层。
- `routes/` 下**不导出 Router 的纯工具**（如 `pagination.ts` 的分页参数解析）不算「横向依赖」：它不含路由、不依赖任何 Store，被多个路由 import 是复用。判断标准是「这个文件是否导出了 Router」。
- 依赖一律显式注入：`AppDependencies` 定义在 `dependencies.ts`，路由只 import 该类型，避免反向依赖 `app.ts`。
- 模块内不 import 单例、不直接读 `process.env`，配置只经 `configuration/config` 获取。
- 新增依赖项时同步 `AppDependencies` 与 `index.ts` 的装配代码。

### 文件与目录组织

- **单文件行数上限 250 行**（含注释），约束对象是 `src/` 下的源码模块：`__vitest__/` 的用例文件按被测模块组织，长度由用例数决定，不受此限。超过就按关注点拆进同名子目录，子目录的 `index.ts` 只做聚合导出，不承载实现。
- **父目录原本只有这一个文件时不建同名子目录**，直接平铺：`rag/store.ts` 拆出的文件就落在 `rag/` 下，而不是再套一层 `rag/store/`（拆分前 `rag/` 只有它一个文件）。父目录已有其他模块并存时子目录才有区分意义，如 `llm/tools/`、`configuration/config/`、`conversation/store/`。
- 拆分以「关注点」为单位：抽走可独立成模块的辅助函数与类型定义即可。**不把一个 class 切成多个互相转发的 class**——类本身通常已经是深模块，拆开只会得到一组更浅的模块。
- `routes/` 按访问者分层：客户端接口收进 `routes/client/`，管理端接口收进 `routes/admin/`，一个模块一个文件，模块内部只写相对路径。根目录只留 `index.ts`（注册表）与 `pagination.ts`（两端共用的纯工具）。
- 管理端各模块**各自挂一遍 `adminGuard`**，并把更具体的路径登记在 `/api/admin` 之前：`app.use('/api/admin', ...)` 会前缀匹配全部 `/api/admin/*`，排在前面时同一次请求会先跑一遍守卫、再落到具体模块，鉴权与审计记录都会重复一遍。
- 目录导入在 NodeNext 下必须写全：`../routes/admin/users.js`、`./conversation/store/index.js`、`./rag/index.js`，省略 `index.js` 后 Node 无法解析。

## 2. 新增接口的标准动作

1. 在 `routes/client/<name>.ts`（管理端为 `routes/admin/<name>.ts`）导出 `create<Name>Router(deps)` 工厂，路由体内只做参数校验、状态码与调用下层，不写业务编排。工厂签名用 `Pick<AppDependencies, 'a' | 'b'>` 只声明本模块真正用到的依赖：调用处不必关心中间件与其余依赖，`registerRoutes` 里各路由形状一致，测试也只需构造用到的那几项。
2. 在 `routes/index.ts` 追加一行 `app.use('/api/<name>', [requireAuth,] create<Name>Router(...))`。**挂载前缀与模块路由内的路径只能有一处写模块名**：挂在 `/api/admin/logs` 的模块，内部就写 `/` 与 `/:id`。两处都写会拼出 `/api/admin/logs/logs` 这类路径，前端一律 404，而类型检查、lint 与「直调处理函数」的单测全是绿的——这类缺陷只能靠真实请求发现，回归用例见 `__vitest__/adminRoutes.test.ts`。
3. 鉴权策略在 `registerRoutes` 集中声明，不在单个路由内部重复校验。
4. 需要新能力时先在 `services/` 或对应领域目录实现，再在路由调用。
5. 补 `src/__vitest__/` 用例。

## 3. HTTP 约定

- 接口前缀统一 `/api/*`。
- 错误响应固定为 `{ message: '中文可读提示' }`，不返回堆栈。
- 状态码常量统一取自 `@repo/reusable` 的 `HTTP_STATUS`（与桌面端共用同一份取值，见 `docs/adr/0001-http-status-contract.md`），代码里不写字面量数字。
- 成功档：`200` 普通响应、`201` 新建资源、`204` 删除与登出等无响应体的成功。
- 错误档只保留四个：`400` 参数非法、`401` 未登录或登录失效、`404` 资源不存在、`500` 服务内部错误。需要第五种含义时先改本节、再改 `HTTP_STATUS`，不要就地造码。
- 有意不引入 `403` 与 `409`：权限不足按「资源不存在」处理（第 4 章），用户名冲突按「参数非法」处理。客户端真正会分支的只有「登录失效」与「资源没了」两种情况，多登记的档位只会诱使两端为不会发生的事写代码。
- `5xx` 对外一律 `500`，细节留在服务端日志（第 10 章）；文案允许翻译成依赖服务相关的可读提示（如「文档入库失败：<原因>」），让用户自行判断是不是向量化服务没启动，但不透出堆栈。
- 鉴权失败文案固定为「登录已失效，请重新登录」（取自 `@repo/reusable` 的 `SESSION_EXPIRED_MESSAGE`，桌面端登录页展示同一句话，避免两端各写一份而漂移）；账号密码错误统一为「用户名或密码错误」，不区分具体原因。这两条与「服务内部错误」收在 `messages.ts` 的 `ERROR_MESSAGE`，被多处引用时不再各自手抄。
- 健康检查 `GET /api/health` 返回 `status / service / provider / model / knowledgeEnabled / timestamp`，供客户端展示连接状态。

## 4. 鉴权与数据隔离

- 认证方式为 `Authorization: Bearer <uuid>`，token 存 `user_sessions` 表，有效期 7 天。
- 采用单端登录：同一用户新建会话时先删除旧会话（事务内完成），保证 `user_id` 只有一条有效记录。
- `createRequireAuth(sessions)` 校验通过后把 `userId` 与 `token` 写入 `res.locals`，读取只用 `currentUserId(res)` / `currentToken(res)`。
- 所有会话、消息、知识库操作必须带 `user_id` 过滤，禁止仅按 id 查询后返回。
- 知识库分 `global`（全局共享）与 `private`（仅上传者）两类，归属记在 `owner_user_id`；列表与检索统一用 `(scope = 'global' OR owner_user_id = <uid>)` 过滤，权限不足一律按“不存在”处理，不泄漏他人文档信息。
- 用户身份要传到工具层：`AgentService.stream` 把 `userId` 放进 `configurable`，工具回调从 `config.configurable.userId` 读取；缺失身份时直接抛错，禁止退化成不过滤。
- 全局文档不开放客户端写入，只由管理令牌（`KNOWLEDGE_ADMIN_TOKEN` 与请求头 `x-admin-token`）校验的接口维护，令牌留空即视为关闭该能力。

## 5. SSE 流式对话

- 编排集中在 `services/chatStream.ts` 的 `streamChatReply()`：落库提问 → 流式写回 → 落库回复 → 回滚没有产出的新建会话；`routes/chat.ts` 只负责参数校验（400）与会话归属校验（404）。
- 落库提问必须在 `flushHeaders()` 之前完成，落库失败才能按普通请求返回 500，而不是已 flush 的事件流。
- 响应头固定三件套：`text/event-stream; charset=utf-8`、`no-cache, no-transform`、`keep-alive`，随后 `flushHeaders()`。
- 事件格式 `data: {...}\n\n`，`type` 取值 `conversation` / `token` / `tool` / `source` / `file` / `done` / `error`，类型声明统一取 `@repo/reusable` 的 `ChatStreamEvent`（两端各写一份必然漂移）；`done` 携带 `conversationId` 与 `title`，`file` 携带 `{ fileId, name, size }`（工具产出的导出文件在流末尾统一补推，客户端据此下载），`source` 携带 `{ name }`（检索命中的文档名）。
- `conversation` 事件（携带 `conversationId`）必须在首个 token / tool 之前补推：新建会话「有产出才保留」与「客户端已知晓会话 ID」由此严格对齐，客户端不会记住一个随后会被回滚删除的会话。
- 中断必须监听 `res.on('close')`（`req` 的 `close` 在请求体读取完成后即触发，会误中断流式响应），并用 `res.writableEnded` 排除正常结束；中断时通过 `AbortController` 停止模型推理。
- 客户端主动中断不再回推 `error`；`finally` 中统一 `res.end()`。
- 仅在答复正文非空时落库，避免保存空回复；中断与失败路径同样要把已产出的部分回复落库（用「本轮是否已落库」标志防重复写入，落库失败只 warn），否则用户已经看到的内容会在重开会话后消失。
- 新建会话在本轮既未正常收尾、也没有任何产出（模型服务未启动、刚发出就被停止）时，必须连同刚写入的提问一起删除，否则列表会残留无回复记录、下次发起对话还会再建一条；已经开始产出内容的会话即便被中断也保留，避免丢掉用户刚发出的输入。已推送 `done` 的会话（含空回复）一律保留，避免前端已记住的 `conversationId` 失效。
- 工具产出的结构化结果（导出文件、检索来源）经 `configurable` 上的收集器交回 Agent 层，再由 Agent 转成事件推送：这类信息服务端能确定地摆好，就不要指望模型在正文里自述——提示词层面的要求（如“引用知识库内容必须标注来源”）在小模型上遵循率撑不起主链路。
- 检索来源在工具结束的同一时刻增量推送并按文档名去重，本轮随后被中断也不会丢掉已检索到的出处。

## 6. 数据层

- 消息元数据（`tools` / `attachments` / `sources`）与正文分开成列随消息一起落库，空值写 `null` 而非 `[]`；切换历史会话时按原样回读即可还原工具、附件与来源标签，不必把标签信息塞进正文让模型复述。
- 使用 `mysql2/promise`；连接池由 `db/pool.ts` 创建，建库与建表由 `db/schema.ts` 的 `ensureDatabase` / `ensureTables` 负责，存量表的补列由 `ensureColumns` 负责，`ensureSchema` 作为启动编排入口。
- 建表语句全部 `CREATE TABLE IF NOT EXISTS`，可重复执行；字符集 utf8mb4，时间列用 `DATETIME(3)`，必要处建联合索引与级联外键。
- `CREATE TABLE IF NOT EXISTS` 不会修改已存在的表，新增列必须在 `ensureColumns` 里做条件迁移（先查 `information_schema` 判断列是否存在，再决定是否 `ALTER`），整段必须幂等，重复执行不得报错。
- 查 `information_schema` 时**必须给列起别名**（`SELECT column_name AS name`）：该视图的列定义名是大写 `COLUMN_NAME`，结果对象的键会跟着定义名走，按小写 `column_name` 取值恒为 `undefined`，会把「列已存在」误判成「列不存在」，进而对已有列重复 `ALTER TABLE` 报 `Duplicate column name`。
- 查询一律参数化（`?` 占位），禁止字符串拼接 SQL；动态标识符用 `mysql.escapeId`。
- 时间在应用层生成后写入，读取时统一转回 ISO 字符串。
- 启动时惰性清理过期会话：事务内先删过期记录，再保留每个用户最新一条（自连接删除更早的会话）。
- 知识库不进 MySQL，落在本地 LanceDB 目录（`data/knowledge/lancedb`）：`documents` 存元数据，`chunks` 存片段与向量；表结构显式声明（可空列、`FixedSizeList` 向量维度、数值列用 `Float64` 以免读出 `BigInt`）。
- LanceDB 的过滤表达式使用字符串拼接：只允许拼入白名单校验过的值（UUID、整数 `userId`），其余一律禁止。
- 向量模型或维度变化时必须显式报错（入库与检索都校验），不允许按较短维度截断计算相似度。

## 7. LLM 与工具

- 智能体由 `createAgent` + `streamMode: 'messages'` 构建，系统提示词统一维护在 `llm/prompt.ts`。
- 工具实现在 `llm/tools/`（按关注点分文件），必须自校验入参并在非法时抛出中文错误；知识库检索按调用者可见性过滤，结果需带「来源」标注。
- 模型与嵌入 provider 由 `configuration/config/` 决定（deepseek 走 `ChatOpenAI`，其余走 `ChatOllama`），业务代码不做 provider 判断。
- 文件类工具（`list_files` / `read_file` / `write_file`）只认本轮附件：附件 ID 由路由层校验后经 `configurable.fileIds` 注入，模型编造出的 ID 读不到任何内容，越权读取他人文件不可能发生。
- 图片附件没有可抽取的文字，交给 `llm/vision.ts` 的视觉模型转述成文字后再回填给对话模型；未配置视觉模型时必须返回可读提示，不允许模型凭文件名猜测图片内容。
- 本轮附件在作答前由 `AgentService` 预读成文本注入对话（`readAttachmentText`：图片走视觉模型、其余走解析器），读到的内容直接摆在提问旁边，`read_file` 退为复核手段。不要依赖模型自行决定是否调用读文件工具：实测触发率随提问措辞波动，弱措辞下会连续多轮完全不读并编造内容。
- 网络类异常统一转成可读提示（如 `fetch failed` → 「无法连接对话模型服务」）。

## 8. 配置与环境文件

- 环境变量只在 `configuration/config/` 读取并映射为 `AppConfig`，其它模块一律使用注入的 config，不直接读 `process.env`。
- 新增配置项的标准动作：`AppConfig` 加字段 → `loadConfig()` 读环境变量并给默认值 → 同步 `.env.development` 与 `.env.production` → 同步 `apps/agent-server/README.md` 的配置表。
- 配置按环境拆两份：`.env.development` 供 `pnpm dev`（`tsx watch --env-file`）、`.env.production` 供 `pnpm start`（`node --env-file`），走 Node 原生能力，不引入 dotenv 之类的加载库。
- 系统环境变量优先级高于文件，真实密钥不入库，生产文件只写占位值并在注释中说明注入方式。
- 路径类配置（如 `DATA_DIR`）写进 env 文件时必须用绝对路径，避免随启动目录漂移。
- 可选能力用「留空即关闭」表达：如 `OLLAMA_VISION_MODEL` 留空时，图片理解按能力缺失处理（工具返回可读提示而不是报错），部署环境没装多模态模型也无需改代码。

## 9. ESM 与构建

- `module` 与 `moduleResolution` 为 `NodeNext`，所有相对导入必须带 `.js` 后缀。
- 构建由 `vite.config.ts` 完成（服务端构建 `build.ssr`，`target: node20`）：先 `tsc --noEmit` 做类型检查，再由 `vite build` 把 `src/index.ts` 打成单文件 `dist/index.js`（ESM + sourcemap），产物经 esbuild 压缩，代码部分不含空格与注释。
- 运行期依赖与 Node 内置模块一律外置：`external` 由 `package.json` 的 `dependencies` 动态生成，外置时保留裸包名，新增依赖不必改配置；本地模块的 `.js` 后缀导入由 Vite 解析回 `.ts`。
- 构建前清空 `dist`（`emptyOutDir`，产物为单文件，避免旧编译产物残留）；测试文件位于 `src/__vitest__` 并被 `tsconfig.json` 的 `exclude` 排除，不进入产物。
- `.env.*` 只在运行时由 `node --env-file` 读取，构建时用 `envDir: false` 关闭 Vite 自身的 env 加载，避免生产配置被误读或写进产物。
- 产物里剩下的换行与缩进都在字符串内部（多行 SQL、系统提示词、SSE 报文的 `\n\n`），属数据而非格式，压缩器不会改写；无需为了"产物看起来是单行"去改写这些字面量。
- 单测不连真实数据库与网络，外部依赖用替身隔离，运行 `pnpm --filter @repo/agent-server run test`。

## 10. 日志

- 统一使用公共包 `@repo/logger` 的 `Logger`（`createLogger({ name, level, dir, retentionDays })` 组装控制台与按天轮转的文件输出），不再写裸 `console.*`；`name` 取服务名并决定日志文件名前缀，同目录下多个服务各写各的文件，清理超期文件时不会误删他人内容。
- 装配顺序：根日志在 `index.ts` 与配置一起最先建立，再经 `AppDependencies.logger` 传给 `app.ts`；这样建库等启动环节失败时也有可排查的记录。
- 请求级日志：`createRequestLog` 为每个请求生成 8 位 `requestId`，挂到 `res.locals.log` 与 `res.locals.requestId`，并回写 `x-request-id` 响应头；路由与中间件内取日志只用 `requestLogger(res)`，业务日志自动带上该请求的 `requestId`。
- 一次请求只留一条结果汇总：由 `createRequestLog` 在响应结束时按状态码定级输出（`5xx` = error、`4xx` = warn、其余 = info）；`errorHandler` 不自行打印，只把 5xx 的错误挂到 `res.locals.error` 交给请求日志，避免同一次失败产生两条记录。
- 需要把多条日志串到同一上下文时用 `logger.child({ userId, conversationId })` 派生，不在每次调用里重复传参。
- 埋点要求：失败路径必须带原始 `error` 字段（格式化层会展开堆栈）；成功路径记录可度量的字段（耗时、片段数、答复长度、工具名）。
- 入参出参由请求日志统一记录：查询串、请求体、JSON 响应体都先 `redactValue` 脱敏、再 `preview` 截断（顺序不可颠倒，否则截断成字符串后嵌套的密钥就遮蔽不到了）。SSE 接口不走 `res.json`，其出参须由业务层自行补 `answerPreview` 一类摘要。
- 首行列位固定为「时间 级别 接口路径 消息」：格式化层把 `path` 字段提升到第三列并从行尾跳过，请求日志因此可按接口竖向对照；不带 `path` 的记录自动省略该列，不输出空占位。
- 脱敏：密码、令牌、密钥类字段由 `redactFields` 按字段名统一遮蔽，业务代码不必各自处理。
- 新增日志配置项（如日志目录、保留天数）的标准动作同第 8 章：`AppConfig.log` → 两份 env → `apps/agent-server/README.md` 配置表。

## 11. 自检清单

- `pnpm --filter @repo/agent-server run test` 与 `run build` 通过。
- 新接口已登记到 `routes/index.ts`，鉴权策略与所属前缀正确。
- 错误响应为中文文案且状态码符合第 3 章的约定。
- 状态码取自 `HTTP_STATUS`、固定文案取自 `ERROR_MESSAGE`，未新增字面量数字与手抄文案。
- 涉及 SQL 的改动全部参数化并带 `user_id` 过滤。
- 流式相关改动仍满足"res 监听中断、有正文才落库、finally 关闭响应"。
- 新增配置项已在两份 env 文件与 `apps/agent-server/README.md` 配置表中同步。
- 日志统一走注入的 `Logger`，未新增裸 `console.*`；新增失败路径已带原始 `error` 字段。
