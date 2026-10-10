---
status: proposed
---

# 后端服务的高并发治理：分级闸门、软排队硬拒绝与过载兜底

agent-server 目前对并发**没有任何显式治理**：请求无上限进入、模型调用无并发上限、连接池可无限排队、SSE 无背压、事件循环会被上传解析阻塞。低并发下这些都不显形，一旦并发上来，失效方式是雪崩（内存涨、排队无界、连接的请求全部超时）而不是降级。本文给出单机单实例下的完整兜底方案：以「先保命、再削基线、最后扩容量」的顺序，明确闸门位置、过载口径、失败边界与观测口径。多实例（水平扩展）不在本文范围，只在末尾列出其前置条件。

## 现状

- **进程与 HTTP 层毫无防护**：单进程 `app.listen(config.port)` 启动（[index.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/index.ts#L100-L112)），未用 `http.createServer` 包装，未设置任何一个 server 超时参数；中间件只有 CORS、`express.json({ limit: '2mb' })`、请求日志与错误兜底（[app.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/app.ts#L14-L23)）。
- **无任何并发闸门/限流/超时/重试设施**：在 `apps/agent-server` 全量检索 `p-limit` / `bottleneck` / `semaphore` / `queue` / `cluster` / `timeout` / 限流 均**零命中**。
- **连接池可无限排队**：`connectionLimit: 10`、`waitForConnections: true`，未设 `queueLimit`（缺省即不限制）与 `connectTimeout`（[pool.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/db/pool.ts#L6-L18)）。池满后的请求在内存里无上限堆积，且不知何时该放弃。
- **单轮对话的基线占用偏高**：鉴权每请求一次 `user_sessions` 查询（[middleware.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/auth/middleware.ts#L20-L31)）；`append` 内部先 `get()` 读**该会话全量消息**再 insert + update（[conversations.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/conversation/store/conversations.ts#L91-L148)、[messages.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/conversation/store/messages.ts#L59-L65)）；请求日志在响应结束时**每请求一条 INSERT**（[requestLog.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/middleware/requestLog.ts#L69-L84)）。合计约 8~12 次 DB 往返，且单会话成本随消息数线性累加。
- **模型侧无上限**：模型与 agent 实例全局共享，每轮一次 `agent.stream`，触发治理时再加一次 `model.invoke` 做摘要（[agent.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/llm/agent.ts#L46-L60)、[contextGovernance.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/services/contextGovernance.ts#L60-L63)）；附件预读为逐个串行（[agent.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/llm/agent.ts#L96-L115)）；检索前一次 `embedQuery` HTTP 调用（[storage.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/rag/storage.ts#L128-L135)）。均无超时、无重试、无降级。
- **唯一成熟的一项：中断**。`res.on('close')` 排除 `writableEnded` 后 `controller.abort()`，`AbortSignal` 已贯穿到 `agent.stream`（[chatStream.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/services/chatStream.ts#L74-L79)、[agent.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/llm/agent.ts#L163-L178)）。
- **SSE 无背压**：`send()` 直接 `res.write(...)` 且忽略返回值（[chatStream.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/services/chatStream.ts#L70-L72)）。慢客户端会让增量内容在 Node 侧缓冲里无上限堆积。
- **事件循环会被阻塞**：上传走 `multer.memoryStorage`（默认单文件 20MB 常驻堆，[upload.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/middleware/upload.ts#L15-L20)、[env.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/configuration/config/env.ts#L199-L204)），docx / xlsx / pdf 解析为主线程 CPU 密集计算（[parser.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/files/parser.ts#L17-L58)）。
- **同会话并发写无约束**：同一 `conversationId` 的两轮请求可同时在途，消息交错、摘要在同一截断点上竞争（`saveSummary` 的条件更新只保证截断点单调，不保证消息顺序）。
- **观测口径缺失**：有 requestId 与耗时（[requestLog.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/middleware/requestLog.ts#L27-L84)），但没有活跃流数、排队深度、拒绝数、池等待、事件循环延迟；健康检查是静态返回（[health.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/services/health.ts#L20-L28)），不反映负载与依赖可用性。
- **状态码契约只有七项**：200 / 201 / 204 / 400 / 401 / 404 / 500，且约定「5xx 对外只有一个状态码」（[ADR 0001](0001-http-status-contract.md)、`.trae/rules/backend-design.md` 第 3 章）。**过载拒绝没有可用状态码**，这是本方案必须一并处理的契约缺口。

## 术语

- **在途请求（in-flight）**：已进入 Handler、尚未写出最终响应（含 SSE 正在推流）的请求。它占用额度、数据库连接、模型额度与内存。
- **水位（watermark）**：闸门的两个阈值。低于软水位直接放行；介于软水位与硬水位之间进入有界队列等待；超过硬水位立即拒绝。
- **软排队 + 硬拒绝**：轻微过载用有界队列吸收抖动（带等待超时），重度过载立即失败，保证已接纳的请求不被拖死。
- **背压（backpressure）**：下游（socket）消费不过来时，上游暂停生产，而不是在内存里继续堆积。
- **单轮最长时长**：一轮 SSE 对话允许占用在途额度的最长时间，到点即 `abort` 并按「已产出落库 + 推 error」收尾。
- **熔断半开**：依赖连续失败达阈值后进入快速失败状态，冷却一段时间后放一个探测请求，成功即恢复。
- **分级健康检查**：`/api/health` 只回答「进程活着」（轻量、不受闸门影响）；`/api/health/ready` 才探测 MySQL / 模型 / 向量服务（可被闸门与超时约束）。
- **被拒绝 vs 真故障**：过载拒绝是「少见的正常行为」，必须在日志与指标上与真实错误分开统计，否则污染错误率口径。

## 决策

1. **治理顺序钉死为「先保命 → 再削基线 → 最后扩容量」**：P0 兜底（闸门、超时、背压、进程兜底）→ P1 削减单轮基线占用 → P2 模型与依赖侧治理 → P3 事件循环保护 → P4 观测与压测。理由：P0 不改业务逻辑即可上线，收益最大；P1 把基线降下来，否则 P0 的阈值只能定得极保守。
2. **范围先锁单机单实例，多实例另立项**：当前部署就是单进程，进程内闸门零外部依赖。多实例的前置条件（LanceDB 本地化、限流外移、反代不缓冲 SSE）列在文末，不在本方案内解决。
3. **过载口径：软排队 + 硬拒绝**。软水位之上进有界队列（**队列有长度上限，且有等待超时**），硬水位之上直接拒绝。理由：纯排队会在过载时让等待时间无界增长，是雪崩最快的路径；纯拒绝在突发流量下体感差。两者取长。
4. **状态码契约增补 `503`**：新增 `HTTP_STATUS.SERVICE_UNAVAILABLE`，过载拒绝返回 503 并带 `Retry-After`。理由：过载是**可重试的临时态**，与 `500`（服务内部错误）混用会让客户端无法决定重试策略。这是对 [ADR 0001](0001-http-status-contract.md) 七项契约的**有意增补**，已按「先改 `.trae/rules/backend-design.md` 第 3 章 → 再改 `packages/reusable/src/http.ts`」的顺序落地（追记见 ADR 0001「后续变更」），契约由七项变为八项。除过载外，其余 5xx 仍一律 `500`。
5. **请求分四档，配额互不挤占**：① 健康检查——**不受闸门影响**，必须永远可答；② 对话流（`/api/chat`）——长占用、单独闸门；③ 上传与解析——CPU 密集、单独闸门；④ 普通读写 CRUD（会话 / 文件 / 知识库 / 管理端）——较宽上限。理由：对话流占满时不得让健康检查与后台操作一起失联。
6. **HTTP 层显式设超时与连接回收**：改用 `http.createServer(app)`，设置 `headersTimeout` / `requestTimeout` / `keepAliveTimeout` / `maxRequestsPerSocket`；SSE 路径豁免响应期超时，改由「单轮最长时长」兜底 `controller.abort()`。理由：SSE 的响应期本来就不受 `requestTimeout` 约束，半死连接会永久占住一个在途额度与一份内存。
7. **连接池：`queueLimit` 有界 + `connectTimeout`，池满快速失败**。理由：`waitForConnections: true` + 缺省 `queueLimit` 等于无限排队，等待时间无上限，会出现「排到队时客户端早已离开」。池满即失败比排到超时更省资源。
8. **SSE 背压：`res.write` 返回 `false` 即暂停推进，等 `drain` 再续；慢客户端超时即断开**。理由：这是内存雪崩最短的一条路径，且改动局限在 `send()` 一处。
9. **模型侧显式闸门 + 有界队列 + 等待超时，按 provider 分档**（默认本地 Ollama 1~2、线上 DeepSeek 8，均由环境变量覆盖）。理由：真实瓶颈是模型推理算力，Node 侧不设闸门只是把压力转成一大批并发超时。
10. **滚动摘要走独立低优先队列，不占主对话额度**。理由：摘要是「锦上添花」，不得挤占用户可见的首 token 时延（[ADR 0008](0008-context-window-and-summary.md) 已定摘要失败必须降级、不得阻断对话，这里补上它的资源口径）。
11. **检索与向量化独立小并发 + 超时；读取路径失败降级为「本轮无知识库结果」，写入路径失败必须报错**。理由：检索缺失只影响本轮答案质量，而静默失败的知识库写入会污染库。
12. **同会话串行**：同一 `conversationId` 同刻只允许一轮在途，后续请求进队列或返回 `409`。理由：并发两轮会导致消息交错、摘要截断点竞争，用户看到「答案答的是上一问」。不动全局锁，只按会话维度互斥。
13. **单轮瘦身是治理的一部分，不只是性能优化**：`append` 不再读全量历史、每轮历史只读一次、请求日志批量刷写、鉴权结果做短 TTL 缓存并在登出 / 删除账号时主动失效。理由：基线降不下来，闸门阈值只能定得极保守，吞吐被锁死。
14. **事件循环保护：上传解析单独闸门 + 大文件落临时文件**；解析移入 `worker_threads` 列为 P3 备选（需要新的运行时形态与调试成本，先不上）。理由：一次并发上传就能把全部 SSE 推送卡住，这是「流式体验」的隐性杀手。
15. **进程兜底与优雅停机**：`unhandledRejection` / `uncaughtException` 记录后退出（交由进程守护拉起）；收到 SIGTERM 时停止接受新请求 → 等待在途流至上限 → 关闭连接池与 LanceDB 连接。理由：现在的 `bootstrap().catch` 只覆盖启动阶段（[index.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/index.ts#L115-L119)），运行期崩溃与停机都没有约定。
16. **依赖熔断 + 半开探测**：模型或向量服务连续失败达阈值即快速失败一段冷却时间，随后放一个探测请求。理由：依赖挂掉时把请求排满队、逐个超时，比直接快速失败更糟。
17. **可观测与验收口径先定，再谈调优**：新增活跃流数、队列深度、拒绝数、池等待、连接池超时数、事件循环延迟（`perf_hooks.monitorEventLoopDelay`）、每轮分段耗时（DB / 检索 / LLM）；分级健康检查落地。容量模型近似为 `并发上限 ≈ min(模型并发 × 单轮时长容忍, 池并发 × 单轮往返数, 内存 ÷ 单流占用)`。
18. **全部阈值走环境变量并在 `env.ts` 一处收敛**，给出保命默认值并标注「压测后校准」。理由：默认值只保证不雪崩，不保证吞吐最优，必须可调。

## Considered Options

- **只靠反代 / 网关限流（`limit_conn`）**：当前开发与单机部署没有网关，且网关看不到「模型并发」这个真实瓶颈。否决为单机阶段的方案，保留为多实例阶段的外移项。
- **用 `500` 承载过载、遵守「5xx 只有一个」**：契约零改动、客户端也只需按 5xx 提示重试。但可重试的临时态与真错误混在一起，客户端与运维都无法据状态码区分。否决，改为增补 503（决策 4）；若最终不愿动契约，可用「500 + `Retry-After` + 固定文案」降级实现，代价是重试语义丢失。
- **无限排队直到成功**：实现最简、表面不丢请求，但过载时排队时间无界，雪崩最快。否决。
- **一律快速失败（不排队）**：最保守，突发流量下用户频繁重试。降级为硬水位之上的行为，不作默认。
- **引入 `p-limit` / `bottleneck` 做闸门**：只解决「限并发」一半问题——本方案还要求拒绝时产出契约化响应、与健康检查分流、把排队深度接进日志与指标。否决自研小型闸门之外的依赖（也符合「同一逻辑出现第三次才抽公共」）。
- **用进程内持久队列缓冲请求**：重启即丢、多实例下各算各的，反而制造一致性幻觉。否决，队列只用于削峰、必须有界。
- **给会话写操作加全局串行锁**：最稳，但为低概率并发引入全局锁。否决，改按 `conversationId` 维度互斥（决策 12）。
- **上传解析直接上 `worker_threads`**：效果最彻底，但引入新运行时形态、错误传播与调试成本。降级为 P3 备选，P0 先用并发闸门兜住。
- **健康检查也纳入闸门统一限流**：实现整齐，但过载时运维会同时失去观测手段。否决，健康检查单独留配额。

## Consequences

- **契约变更外溢**：新增 503 需同步 `.trae/rules/backend-design.md` 第 3 章 → `packages/reusable/src/http.ts` → 两端消费方与测试夹具，并在 [ADR 0001](0001-http-status-contract.md) 追记「后续变更」。这是本方案唯一触碰跨端契约之处。
- **新增一批环境变量**（闸门水位、队列长度与等待超时、单轮最长时长、各档并发上限、池 `queueLimit` / `connectTimeout`、HTTP 超时、模型并发与队列、熔断阈值与冷却），须按既有口径同步四件套：`AppConfig` → `loadConfig()` → `.env.development` / `.env.production` → `apps/agent-server/README.md` 配置表。
- **行为变化**：同会话并发从「都执行」变为「一串一排队/一拒」；过载从「都慢慢失败」变为「明确拒绝」。桌面端需要相应的等待态与文案，文案集中放 `messages.ts`。
- **闸门是有状态的内存设施**：进程重启即清零，多实例下各算各的，**不能当作全局配额**——这本身就是多实例阶段必须外移限流的理由。
- **拒绝会被计入 5xx**：必须在日志与指标上把「被闸门拒绝」与「真实故障」分开，否则错误率口径失真、告警噪声变大。
- **阈值必须压测校准**：文档给出的默认值只保证不雪崩；容量基线须由 P4 的压测脚本产出。
- **优雅停机引入等待窗口**：部署时停机时间会长于现在，需要约定等待上限（与「单轮最长时长」同源）。

## 待办（实施时）

- **P0 兜底（不雪崩）**：新建 `middleware/concurrencyGuard.ts` 并在 [routes/index.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/routes/index.ts#L26-L49) 分档挂载；[index.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/index.ts#L100-L112) 改 `http.createServer` 并设超时、加进程级异常兜底与优雅停机；[db/pool.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/db/pool.ts) 加 `queueLimit` / `connectTimeout`；[chatStream.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/services/chatStream.ts#L70-L79) 加背压与单轮最长时长；同会话互斥。测试：放行/排队/拒绝三条路径、池满快速失败、慢客户端断开、超时 abort 后已产出内容仍落库。
- **P1 削基线**：`append` 拆出轻量路径（不再 `get()` 全量历史）、每轮历史只读一次透传给 `streamChatReply`；[logging/store.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/logging/store.ts#L128-L149) 改批量刷写；鉴权结果短 TTL 缓存（`auth/sessionStore.ts` + `auth/middleware.ts`）。测试：单轮 DB 往返次数断言、批量刷写在停机时落尽、缓存登出即失效。
- **P2 模型与依赖**：模型闸门 + 有界队列 + 等待超时（套在 [agent.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/llm/agent.ts#L136-L178) 的 `stream` 外层）；摘要独立队列（[contextGovernance.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/services/contextGovernance.ts)）；检索超时与降级、写入路径不降级（[rag/storage.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/rag/storage.ts#L118-L135)）；熔断半开。
- **P3 事件循环与上传**：[upload.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/middleware/upload.ts) 解析并发闸门 + 大文件落临时文件；评估 [parser.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/files/parser.ts) 是否移入 `worker_threads`。
- **P4 观测与验收**：指标埋点（含事件循环延迟监控）、`/api/health/ready` 分级健康检查、`scripts/` 下压测脚本（mock 模型打 `/api/chat` 与非流式接口）、容量基线与 SLO（首 token P95、整轮 P95、503 比例、池等待 P95）。
- **跨阶段**：503 契约增补**已落地**（`.trae/rules/backend-design.md` 第 3 章 → `packages/reusable/src/http.ts` → ADR 0001 追记）；其余待办：新增环境变量四件套同步、桌面端等待态与过载文案（`messages.ts` 集中管理）。
- **多实例（另立项，不在本文范围）**：LanceDB 由本地目录改为共享存储或收敛到单实例、限流外移至网关、反代对 SSE 关闭响应缓冲（`proxy_buffering off`）、确认单端登录在共享 `user_sessions` 下的行为不变。**已立项：[ADR 0011](0011-multi-instance-horizontal-scaling.md)（向量库定为 Qdrant、限流与同会话互斥外移 Redis、指标走 Prometheus 拉取，与本节初拟方向不同，取舍以 0011 为准）。**
