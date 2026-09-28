# 跨端数据契约不合并到共享包，各端只共享真正一字不差的取值

后台管理网站（`apps/frontend`）与桌面端（`apps/agent-client`）各自声明了一份接口返回结构类型。常识默认是「跨端共享的类型放共享包」，本文记录为什么这里**刻意不合并**。

判据不是「两边命名像不像」，而是**合并后是否有任何一端被迫接受自己不该看到的字段**。两端的同名字段其实并不同构：

| 概念       | 桌面端                                   | 管理端                                             |
| ---------- | ---------------------------------------- | -------------------------------------------------- |
| 登录用户   | `{ id, username }`                       | `{ id, username, role, status }`                   |
| 会话列表项 | `{ id, title, updatedAt, messageCount }` | 再加 `userId` / `ownerName` / `createdAt`          |
| 知识库文档 | `{ id, title, chunks, createdAt }`       | 再加 `scope` / `ownerUserId` / `ownerName`         |
| 消息       | 含 `steps` / `files` 等交互态字段        | 只读子集，另有 `tools` / `attachments` / `sources` |

把它压成一份「最全」的类型，代价是桌面端能看到 `ownerName`、`actorId` 这类管理端专属字段，或者逼后端为了类型统一多返回客户端用不上的数据。真正一字不差的只有 `MessageRole` 一项，且目前只有前端一处使用——搬进包里不减少任何重复，只多一层间接。

## Considered Options

- **整份 `api/types.ts` 上提 `@repo/reusable`**：否决。两端字段集不同（见上表），合并等于让桌面端承担管理端契约的变更成本。
- **只上提共用的子集（`MessageRole` / `UserRole` / `UserStatus` / `PageResult`）**：可行但不做。这些都是**单处使用**，没有第二份手抄可消除；仓库既有口径是「同一逻辑出现第三次时才抽公共能力」，类型同理。等桌面端真的要用 `role` 做门禁、或出现第二份同形分页信封时再上提，那时才有真实的重复可消除。
- **由 `agent-server` 导出类型供两端 import**：否决。会让客户端反向依赖服务端源码，破坏「`apps/*` 之间不得互相 import」的边界。

## Consequences

- 两端的契约类型各自维护，后端改返回结构时需要两侧同步——这是本决策已知的成本。因此 `apps/frontend/src/api/types.ts` 的文件头注释必须写明它与 `agent-server` 的哪些路由同源、改动需两侧同步。
- `@repo/reusable` 继续只放「换一个业务仍然用得上」的取值契约（`HTTP_STATUS`、SSE 事件类型、`SESSION_EXPIRED_MESSAGE`），不放页面级的接口返回结构。
- 边界仍用「是否与业务约定绑定」这把尺子，但要补一句：**「可复用」不等于「应该复用」**。抽取的前提是有第二处真实使用，而不是有第二处相似命名。
