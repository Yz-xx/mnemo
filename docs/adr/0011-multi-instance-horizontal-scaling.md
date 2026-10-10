---
status: proposed
---

# 后端多实例（水平扩展）：共享状态外移、Qdrant 与 Redis 前置

[ADR 0010](0010-concurrency-governance.md) 把单机单实例的「不雪崩」钉死了，但它明确把多实例列为「另立项」：闸门、会话锁、鉴权缓存、指标都是**进程内状态**，多实例下各算各的，不能当全局配额；LanceDB 是**嵌入式本地库**，多进程写同一目录会冲突。本文锁定水平扩展的目标形态——**多机 + 反向代理**：向量库替换为 Qdrant，全局限流与同会话互斥外移到 Redis（并顺带接管鉴权缓存），指标由 Prometheus 拉取；存量向量数据一次性迁移 + 停机切换。

## 现状

- **闸门是进程内状态**：通用有界并发原语 [gate.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/concurrency/gate.ts)（`inFlight` / `rejected` / `waiting`）分档挂在 [concurrencyGuard.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/middleware/concurrencyGuard.ts)，各实例独立计数。
- **同会话互斥是进程内 Map**：[lock.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/conversation/lock.ts) 按 `conversationId` 维护 `Map<string, Promise<void>>` 的等待链，跨实例完全失效。
- **鉴权缓存是进程内短 TTL**：P1 引入的进程内缓存（见 ADR 0010 决策 P1）在登出 / 换端后，其它实例上的条目要靠 TTL 过期才会失效。
- **向量库是嵌入式本地库**：[store.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/rag/store.ts) 使用 LanceDB，数据目录由配置给出，[storage.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/rag/storage.ts) 单连接惰性复用、写入走 delete + add；多进程写同一目录会冲突。
- **指标只在进程内**：[observability/](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/observability) 的计数与直方图均驻留进程，只有 [readiness.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/services/readiness.ts) 的快照可读，无跨实例聚合，也没有 `/metrics`。
- **SSE 直接写 socket**：[eventStream.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/services/eventStream.ts) 设 `text/event-stream` 并 `flushHeaders()`，写缓冲满时等 `drain`；未考虑反向代理的响应缓冲。
- **会话 / 登录已是共享的**：令牌落 MySQL `user_sessions`，`create()` 删旧插新保证单端登录（[sessionStore.ts](file:///d:/Files/common/porgram/my-monorepo/apps/agent-server/src/auth/sessionStore.ts)）——跨实例看是共享的，这一项无需外移。
- **启动无反代**：`app.listen` 单进程启动，前面没有反向代理，因此也没有 `limit_conn` 之类的总闸。

## 术语

- **多实例**：同一后端的多个进程（多机或同机多进程），前面有反向代理；实例可被滚动替换。
- **共享状态外移**：把进程内状态（限流额度、互斥锁、鉴权缓存、指标）迁到所有实例可见的外部设施（Redis / Prometheus）。
- **全局配额**：跨实例合计的并发上限，取代「单实例上限 × 实例数」的近似。
- **令牌桶**：按固定速率补充令牌、请求取令牌的限流实现；本文用 Redis 承载跨实例共享的桶。
- **分布式锁**：以 Redis 键表达「某会话正在处理」，带 TTL 与续期，实例崩溃后可自愈。
- **粘性路由**：按 `conversationId` 把请求固定到同一实例（本次否决，见 Considered Options）。
- **摘流 / 放流**：滚动发布时把实例从反向代理上游摘除（停止接新请求），替换完成后再放回。

## 决策

1. **部署形态锁定为「多机 + 反向代理」**：Nginx 前置承担 TLS、SSE 透传与总闸，后端实例尽量保持无状态。
2. **向量库替换为 Qdrant**：嵌入式 LanceDB 改为独立的 C/S 向量服务，多实例共享；现有「文档表 / 片段表」映射为 Qdrant 的 collection 与 payload。
3. **全局限流外移到 Redis 共享令牌桶**，覆盖**入口档位（对话 / 上传 / CRUD）与模型档位**（模型是真实瓶颈）；摘要 / 检索 / 解析档位保持实例独立（低频、非瓶颈）。
4. **同会话互斥外移为 Redis 分布式锁**：键按 `conversationId`，带 TTL 与续期，超时仍抛 `ConversationBusyError`。
5. **Redis 同时承载鉴权缓存**：把 P1 的进程内短 TTL 缓存换成 Redis，登出 / 换端 / 停用时删除对应键，跨实例即时失效。
6. **指标集中采集走 Prometheus 拉取**：各实例新增 `GET /metrics`（Prometheus 文本格式），对接现有 `observability` 注册表。
7. **存量向量一次性迁移 + 停机切换**：在停机窗口内导出 LanceDB 并写入 Qdrant，切换后不再双写。
8. **滚动发布据 `/ready` 摘流**：替换实例前先从反代上游摘除，等在途请求结束（复用 ADR 0010 优雅停机的等待上限）再下线。

## Considered Options

- **粘性路由（把会话固定到同一实例）**：免去分布式锁，但实例故障即导致该会话中断、扩缩容时重分布复杂。否决，改用 Redis 锁。
- **向量库其他选型**：Milvus（集群组件多、运维明显更重）、pgvector（要在 MySQL 之外再引入 Postgres）。否决，选 Qdrant。
- **LanceDB 共享对象存储**：写入并发一致性难以保证，且把可用性绑到对象存储上。否决。
- **只用反代 `limit_conn`**：粒度粗，看不到「模型并发」这个真实瓶颈。否决为唯一手段（保留作总闸兜底）。
- **实例独立配额 + 网关总闸**：总量近似、削峰不平滑。否决。
- **接受弱化 + DB 兜底（放弃严格串行）**：极端并发下消息顺序仍可能交错。否决。
- **推送式指标 / 暂不集中**：前者需处理推送失败与重复，后者无法跨实例聚合。否决。
- **双写灰度迁移**：无停机窗口，但要维护双写一致性与回滚路径。否决，存量一次性迁移。

## Consequences

- **新增三项基础设施依赖**：Nginx、Redis、Qdrant，各自成为新的故障域；Redis 不可用时必须明确降级策略（限流是放行还是拒绝、锁如何退化）。
- **容量模型变为分档合计**：单实例上限不再等于可扩展总量，总容量受 Qdrant / Redis / MySQL 与下游模型服务共同约束。
- **锁必须带 TTL 与续期**：否则实例崩溃会留下死锁；续期失败应中止本轮而非静默续跑。
- **鉴权缓存失效路径**：登出 / 换端 / 停用需删对应键，残留键靠 TTL 兜底。
- **SSE 与反代调优**：需 `proxy_buffering off`、`proxy_http_version 1.1`，且 `proxy_read_timeout` 与「单轮最长时长」对齐，否则流会被缓冲或提前切断。
- **本地开发形态变化**：开发需本地起 Redis / Qdrant（或提供内存替身 / compose），否则跑不起来。
- **配置四件套**：新增 Redis、Qdrant 与反代相关环境变量，按既有口径同步 `AppConfig` → `loadConfig()` → `.env.development` / `.env.production` → `apps/agent-server/README.md`。
- **可分阶段回退**：Qdrant 替换与 Redis 限流可分批上线，避免一次性大爆炸。

## 待办（实施时）

- **阶段 1 基础设施与配置**：引入 Redis 与 Qdrant 客户端、连接配置，并把二者可用性并入 `/api/health/ready`；补齐本地开发用的 compose 或替身。
- **阶段 2 向量库替换**：把 `KnowledgeStorage` 抽成接口，新增 Qdrant 适配器；编写一次性迁移脚本与切换 / 回滚步骤。
- **阶段 3 全局限流**：用 Redis 令牌桶替换入口与模型档位闸门；定义 Redis 不可用时的降级策略并补测试。
- **阶段 4 同会话互斥**：用 Redis 分布式锁替换进程内 Map，覆盖 TTL / 续期 / 实例崩溃自愈的测试。
- **阶段 5 鉴权缓存**：进程内短 TTL 缓存换 Redis，登出 / 换端删键，补跨实例失效测试。
- **阶段 6 指标与反代**：新增 `/metrics`；落地 Nginx 配置（SSE 透传与总闸）与 Prometheus 抓取。
- **阶段 7 验收**：多实例压测（复用 P4 的 `bench` 脚本）、滚动发布摘流验证、容量基线重标定。
