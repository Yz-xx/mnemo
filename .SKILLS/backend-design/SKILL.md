---
name: backend-design
description: apps/backend 的设计规范，涵盖分层结构与依赖方向、组合根与依赖注入、路由与鉴权、SSE 流式对话协议、MySQL 数据层与错误码约定。新增或修改后端接口、服务、数据层与中间件时使用。
keywords: backend, express, langchain, mysql, sse, 鉴权
---

# 后端设计规范

## 1. 分层与依赖方向

```text
apps/backend/src/
├── index.ts          组合根：读配置 → 建库表 → 建连接池 → 装配 Store/Service → createApp → listen
├── app.ts            createApp：仅"通用中间件 → 注册路由 → 错误兜底"三段骨架
├── dependencies.ts   AppDependencies 接口，运行期依赖集合
├── config.ts         env 读取 + 默认值 + describeChatModel
├── middleware/       cors.ts、errorHandler.ts
├── routes/           各接口路由；index.ts 统一注册前缀与鉴权
├── services/         跨路由的编排逻辑（chatStream.ts）
├── auth/             userStore / sessionStore / middleware / credentials
├── conversation/     会话与消息持久化
├── llm/              agent、model、tools
├── rag/              知识库存储与检索
├── db/               pool.ts、schema.ts
└── __vitest__/       单元测试（不参与编译产物）
```

- 依赖方向单向：`routes → services → store/llm/db`，下层不得反向 import 上层。
- 依赖一律显式注入：`AppDependencies` 定义在 `dependencies.ts`，路由只 import 该类型，避免反向依赖 `app.ts`。
- 模块内不 import 单例、不直接读 `process.env`，配置只经 `config.ts` 获取。
- 新增依赖项时同步 `AppDependencies` 与 `index.ts` 的装配代码。

## 2. 新增接口的标准动作

1. 在 `routes/<name>.ts` 导出 `create<Name>Router(deps)` 工厂，路由体内只做参数校验、状态码与调用下层，不写业务编排。
2. 在 `routes/index.ts` 追加一行 `app.use('/api/<name>', [requireAuth,] create<Name>Router(...))`。
3. 鉴权策略在 `registerRoutes` 集中声明，不在单个路由内部重复校验。
4. 需要新能力时先在 `services/` 或对应领域目录实现，再在路由调用。
5. 补 `src/__vitest__/` 用例。

## 3. HTTP 约定

- 接口前缀统一 `/api/*`。
- 错误响应固定为 `{ message: '中文可读提示' }`，不返回堆栈。
- 状态码：`400` 参数非法；`401` 未登录或登录失效；`404` 资源不存在；`500` 服务内部错误。
- 客户端类错误透传原始信息；`5xx` 统一返回「服务内部错误」并在服务端 `console.error`。
- 鉴权失败文案固定为「登录已失效，请重新登录」；账号密码错误统一为「用户名或密码错误」，不区分具体原因。
- 健康检查 `GET /api/health` 返回 `status / service / provider / model / knowledgeEnabled / timestamp`，供客户端展示连接状态。

## 4. 鉴权与数据隔离

- 认证方式为 `Authorization: Bearer <uuid>`，token 存 `user_sessions` 表，有效期 7 天。
- 采用单端登录：同一用户新建会话时先删除旧会话（事务内完成），保证 `user_id` 只有一条有效记录。
- `createRequireAuth(sessions)` 校验通过后把 `userId` 与 `token` 写入 `res.locals`，读取只用 `currentUserId(res)` / `currentToken(res)`。
- 所有会话、消息、知识库操作必须带 `user_id` 过滤，禁止仅按 id 查询后返回。

## 5. SSE 流式对话

- 编排集中在 `services/chatStream.ts` 的 `streamChatReply()`；`routes/chat.ts` 只负责参数校验、会话归属校验与用户消息落库。
- 响应头固定三件套：`text/event-stream; charset=utf-8`、`no-cache, no-transform`、`keep-alive`，随后 `flushHeaders()`。
- 事件格式 `data: {...}\n\n`，`type` 取值 `token` / `tool` / `done` / `error`；`done` 携带 `conversationId` 与 `title`。
- 中断必须监听 `res.on('close')`（`req` 的 `close` 在请求体读取完成后即触发，会误中断流式响应），并用 `res.writableEnded` 排除正常结束；中断时通过 `AbortController` 停止模型推理。
- 客户端主动中断不再回推 `error`；`finally` 中统一 `res.end()`。
- 仅在答复正文非空时落库，避免保存空回复。

## 6. 数据层

- 使用 `mysql2/promise`；连接池由 `db/pool.ts` 创建，建库与建表由 `db/schema.ts` 的 `ensureDatabase` / `ensureTables` 负责，`ensureSchema` 作为启动编排入口。
- 建表语句全部 `CREATE TABLE IF NOT EXISTS`，可重复执行；字符集 utf8mb4，时间列用 `DATETIME(3)`，必要处建联合索引与级联外键。
- 查询一律参数化（`?` 占位），禁止字符串拼接 SQL；动态标识符用 `mysql.escapeId`。
- 时间在应用层生成后写入，读取时统一转回 ISO 字符串。
- 启动时惰性清理过期会话：事务内先删过期记录，再保留每个用户最新一条（自连接删除更早的会话）。

## 7. LLM 与工具

- 智能体由 `createAgent` + `streamMode: 'messages'` 构建，系统提示词统一维护在 `llm/agent.ts`。
- 工具实现在 `llm/tools.ts`，必须自校验入参并在非法时抛出中文错误；知识库检索结果需带「来源」标注。
- 模型与嵌入 provider 由 `config.ts` 决定（deepseek 走 `ChatOpenAI`，其余走 `ChatOllama`），业务代码不做 provider 判断。
- 网络类异常统一转成可读提示（如 `fetch failed` → 「无法连接对话模型服务」）。

## 8. ESM 与构建

- `module` 与 `moduleResolution` 为 `NodeNext`，所有相对导入必须带 `.js` 后缀。
- 构建执行 `tsc -p tsconfig.json` 输出 `dist`；测试文件位于 `src/__vitest__` 并被 `tsconfig.json` 的 `exclude` 排除，不进入产物。
- 单测不连真实数据库与网络，外部依赖用替身隔离，运行 `pnpm --filter @repo/backend run test`。

## 9. 自检清单

- `pnpm --filter @repo/backend run test` 与 `run build` 通过。
- 新接口已登记到 `routes/index.ts`，鉴权策略与所属前缀正确。
- 错误响应为中文文案且状态码符合约定。
- 涉及 SQL 的改动全部参数化并带 `user_id` 过滤。
- 流式相关改动仍满足"res 监听中断、有正文才落库、finally 关闭响应"。
