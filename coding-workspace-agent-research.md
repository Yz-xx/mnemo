# 桌面端智能体「选择工作区 + 自主编码」能力调研与实施方案

> 状态：**仅调研，未改动任何代码**。日期 2026-09-27。
> 结论中的每条外部事实都附有一手来源（官方文档 / 官方仓库源码 / 规范原文），仓库事实附文件路径。

---

## 0. 结论摘要

**差距**：现在的智能体是「对话 + 两个外部信息工具」，完全不具备文件系统与命令执行能力；要像 Codex 那样工作，缺的不是一个工具，而是四层能力：**工作区边界 → 读写执行的工具面 → 审批闸门 → 变更可见与可回滚**。

**最贵的一个决定**：文件读写与命令执行放在**哪一侧**。

- 放后端（`agent-server`）：改动最小，与现有「工具加在 `llm/tools.ts`」的扩展方式完全一致，但等于把用户本机目录交给一个**设计上可以是远端**的服务进程，且没有审批通路。
- 放 Electron 主进程：符合本仓库「不放开渲染进程 Node 能力」的安全基线，且天然拥有用户权限上下文，但当前 SSE 是**单向流**，模型要等客户端执行结果就必须把协议双向化——这是真正的架构变更，应当先落 ADR。

**推荐路线**：分两期。一期把工作区做成**后端持有的受限形态**（只读优先 + 命令白名单 + 显式开启），用来验证工具面与提示词；二期把写与执行**下沉到主进程**并补审批 UI，同时把 SSE 扩成「服务端可发起、客户端可回执」。若一开始就确定「后端不允许碰本机文件」，则应跳过一期直接做二期。

**两个最容易被低估的约束**：

1. 本地小模型（`qwen2.5:7b`）不足以支撑多轮工具编排的编码任务，方案里必须包含「换模型」这一项，否则功能做出来也不可用。
2. Prompt injection：工作区里的文件内容（README、依赖里的注释、issue 文本）会成为指令来源，MCP 规范对这点有明确要求——**始终保留人类拒绝工具调用的能力**。

---

## 1. 现状盘点

| 能力           | 现状                                                                                                       | 证据                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 工具定义与注册 | 三个工具，`tool() + zod schema`，集中在 `createTools()` 返回数组                                           | [tools.ts](apps/agent-server/src/llm/tools.ts#L37-L91)     |
| 工具轨迹上报   | LangChain 消息流 → `{ type: 'tool', name, status }` 事件                                                   | [agent.ts](apps/agent-server/src/llm/agent.ts#L57-L90)     |
| SSE 线协议     | 封闭联合类型：`token` \| `tool` \| `conversation` \| `done` \| `error`，**单向**                           | [chat.ts](packages/reusable/src/chat.ts#L8-L24)            |
| 服务端分层     | `routes → services → store/llm/db` 单向，依赖显式注入 `AppDependencies`                                    | backend-design §1                                          |
| 桌面端三层     | 主进程只做设置/主题/窗口/IPC；渲染进程无任何文件能力                                                       | [ipc.ts](apps/agent-client/src/main/ipc.ts#L6-L38)         |
| preload 暴露面 | `initialSettings` / `getAppInfo` / `getSettings` / `saveSettings` / `windowControl`，**无目录选择、无 fs** | [types.ts](apps/agent-client/src/preload/types.ts#L34-L42) |
| 设置持久化     | `AppSettings{backendUrl, theme, authToken}` → `userData/settings.json`                                     | [types.ts](apps/agent-client/src/preload/types.ts#L9-L23)  |
| 安全基线       | `contextIsolation: true`、`nodeIntegration: false`，不放开渲染进程 Node 能力                               | desktop-design §2                                          |
| 决策记录       | `docs/adr/` 下**只有** 0001（HTTP 状态码契约），无工作区/沙箱/审批相关 ADR                                 | `docs/adr/0001-http-status-contract.md`                    |

---

## 2. 需要做哪些功能（能力清单）

按「从选目录到能把活干完」排序，共 8 组。**加粗**项是缺了就无法闭环的必需项。

### A. 工作区生命周期

1. **选择目录**：主进程 `dialog.showOpenDialog({ properties: ['openDirectory'] })`（官方 API：`dialog.showOpenDialog`）。
2. **持久化与恢复**：工作区路径进 `AppSettings`，重启后恢复（走 desktop-design §8 的四步清单）。
3. **会话与工作区绑定**：一个会话锁定一个工作区，避免同一对话在两个目录间漂移；服务端需记录 `conversationId → workspace`。
4. 多工作区切换与最近列表（可后置）。

### B. 文件系统工具面

5. **列目录 / 模糊找文件**：`list_files`（含深度与忽略规则）。
6. **读文件**：`read_file`，支持行区间，超长截断并明确告知被截断。
7. **正则检索**：`search_in_files`，基于 ripgrep；官方 README 明确它默认遵守 `.gitignore`、跳过隐藏与二进制文件，正是编码场景想要的行为。
8. **写文件**：`write_file`（整文件）与 **`apply_patch`**（局部改动）。Codex 用的是自定义 patch 工具（argv0 别名 `apply_patch`/`applypatch`，由 `codex-apply-patch` crate 提供）；Aider 官方列出的编辑格式有 `whole` / `diff`（`<<<<<<< SEARCH` / `>>>>>>> REPLACE`）/ `diff-fenced` / `udiff`。**建议先只支持 SEARCH/REPLACE 一种**，格式越少，模型越不容易产出无法解析的补丁。
9. 删除/重命名：**建议一期不做**，用「写空内容 + 人工确认」代替，降低不可逆风险。

### C. 命令执行

10. **`run_command`**：`spawn` 的 `cwd` 固定为工作区、`timeout` 兜底、`killSignal`（默认 `SIGTERM`）、`signal` 接 `AbortController` 以支持「停止」按钮（官方选项：Node `child_process` 文档）。
11. 输出截断与退出码回传；**禁止交互式命令**（无 TTY，遇到 `stdin` 等待必须超时退出）。

### D. 审批与权限（决定安全上限）

12. **分级审批**：读免批、写需批、命令需批、网络需批。Codex 的模型可直接借鉴：`approval_policy`（`untrusted` / `on-request` / `never` / 结构化 `granular`）× `sandbox_mode`（`read-only` / `workspace-write` / `danger-full-access`），`Auto` 预设即 `workspace-write + on-request`。
13. **审批 UI**：改动前给 diff、命令前给完整命令行与 cwd，用户可拒绝（MCP 规范 tools 页原文：_"there SHOULD always be a human in the loop with the ability to deny tool invocations"_）。
14. 权限规则文件（allow/ask/deny 列表），参考 Claude Code 的评估顺序：**hooks → deny → ask → 模式 → allow**，且 `deny` 在最高权限模式下依然生效。

### E. 变更可见与可回滚

15. **diff 视图**：按文件展示增删行，工具事件里带结构化 diff 而不是纯文本。
16. **检查点/回滚**：Cline 的做法是维护**独立于项目 Git 的 shadow git 仓库**，每次工具调用后提交快照，恢复粒度分「只还原文件 / 只还原任务 / 两者」。

### F. 上下文与提示词

17. **项目规则文件**：`AGENTS.md` 已是跨工具开放格式（规范见 agents.md）；Cline 以 `.clinerules/` 为主并兼容 `AGENTS.md`。建议直接支持 `AGENTS.md` + 本仓库已有的 `.trae/rules/`。
18. **repo map**：Aider 会对整仓生成类/函数签名的精简地图，按图排序在 token 预算内挑最相关部分（`--map-tokens` 默认 1k），构建依赖 tree-sitter。**一期可用「目录树 + 关键文件摘要」近似**，不必上 tree-sitter。
19. 忽略规则统一走 `.gitignore`，与 ripgrep 默认行为对齐。

### G. 协议与持久化

20. **SSE 事件扩展**：新增 `file_change`（结构化 diff）、`command_output`、`approval_request` 等类型，必须同步 `packages/reusable/src/chat.ts` 与两端消费点。
21. **双向化（仅方案二需要）**：服务端发起工具调用 → 客户端执行 → 回执，需要新接口承载回执并处理超时/断连。
22. **审计**：工具调用与执行结果落库，便于复盘「谁在哪个工作区改了什么」。

### H. 界面

23. 顶部工作区指示器（当前目录 + 切换入口）。
24. 变更面板（本次会话改过哪些文件）+ diff 查看。
25. 审批卡片（批准/拒绝/本次会话内总是允许）。
26. Plan / Act 双模式：Cline 的 Plan 模式可读代码与搜索但**不能改文件、不能执行命令**，Act 才执行——这是低成本高收益的安全设计，建议早期就加。

---

## 3. 关键架构抉择：执行放在哪一侧

| 维度           | 放后端（agent-server）                       | 放主进程（Electron main）             |
| -------------- | -------------------------------------------- | ------------------------------------- |
| 改动面         | 小：加工具 + 加配置                          | 大：SSE 单向 → 双向 + 新接口 + 状态机 |
| 与现有扩展方式 | 完全一致（`llm/tools.ts`）                   | 需要新协议与新 IPC                    |
| 语义           | 错位：后端设计上可远端，却要读写用户本机目录 | 正确：执行发生在用户机器、用户权限下  |
| 审批通路       | 无天然通路（要额外造 UI 回执）               | 天然：主进程可弹窗、可拒绝            |
| 安全基线       | 后端进程权限过大，且无内核沙箱               | 可复用 Electron 安全基线              |
| 上下文         | 工作区在服务器上，`rg` 直接可用              | 需要在主进程实现搜索或走 IPC          |
| 多客户端       | 天然支持                                     | 需处理「同一会话多窗口」的归属        |

**为什么这是最贵的决定**：当前 `ChatStreamEvent` 是封闭联合类型、SSE 只有服务端 → 客户端一个方向（[chat.ts](packages/reusable/src/chat.ts#L8-L24)）。方案二要让「LangChain 的工具执行」等一个来自客户端的回执，等于把一次对话从「单向广播」变成「带往返的会话」，所有超时、取消、断连、重放语义都要重新定义。

---

## 4. 三个可行方案

### 方案一：后端持有工作区（最小可用）

**形态**：后端启动时确定工作区根（配置或客户端经接口下发），工具直接在后端进程读写与执行；客户端只负责「选目录」与展示。

改动清单（逐文件）：

| 位置                                                                          | 改动                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/agent-server/src/llm/tools.ts`                                          | `createTools()` 增加文件与命令工具（或拆出 `llm/workspaceTools.ts`，避免单文件膨胀） |
| `apps/agent-server/src/workspace/`（新增目录）                                | 路径解析与边界校验、忽略规则、命令执行封装                                           |
| `apps/agent-server/src/config.ts` + `.env.*` + README 配置表                  | 新增 `WORKSPACE_ROOT` 等；**路径类配置必须绝对路径**（backend-design §8）            |
| `apps/agent-server/src/routes/workspace.ts` + `routes/index.ts`               | 下发/切换工作区（走 `create<Name>Router(deps)` 与集中鉴权）                          |
| `db/schema.ts`                                                                | 会话与工作区绑定（`CREATE TABLE IF NOT EXISTS`）                                     |
| `apps/agent-client/src/preload/types.ts` + `main/ipc.ts` + `preload/index.ts` | 新增 `workspace:pick` 通道（三处同步，desktop-design §3）                            |
| `apps/agent-client/src/main/dialog` 相关                                      | `showOpenDialog` 选目录                                                              |
| `packages/reusable/src/chat.ts`                                               | 可选：新增 `file_change` 事件                                                        |

**优点**：与现有工具扩展方式零摩擦，先跑通「读 → 改 → 跑测试」闭环最快；测试可完全用后端 vitest（`src/__vitest__/`）覆盖，无需碰 UI。
**缺点**：安全边界最弱（后端进程权限 = 用户权限）；审批要靠额外轮次实现；若后端将来上远端，这个方案直接作废。

### 方案二：执行下沉到主进程（Codex 式）

**形态**：模型与编排仍在后端，**执行发生在客户端主进程**；后端在需要执行时发起请求，客户端执行并回执。

协议改造要点：

```ts
// packages/reusable/src/chat.ts —— 示意：从「单向广播」扩为「带往返的会话」
export type ChatStreamEvent =
  | AgentStreamEvent
  | { type: 'conversation'; conversationId: string }
  | { type: 'approval_request'; requestId: string; tool: string; preview: string } // 新增：等待人确认
  | { type: 'tool_invoke'; requestId: string; tool: string; args: unknown } // 新增：等待客户端执行
  | { type: 'done' }
  | { type: 'error'; message: string };
```

- 客户端回执走新接口（如 `POST /api/chat/tool-result`），带 `requestId`、结果或拒绝原因。
- 服务端工具实现变成「发起 + 等待」：LangChain 侧的工具函数需 `await` 一个由 SSE 连接持有的 pending promise，并设超时与取消（用户点「停止」即拒绝所有 pending）。
- 需要处理：客户端中途关闭、重复回执、超时后迟到回执、多窗口归属。

**优点**：执行在本机、审批在主进程、与 Electron 安全基线一致；未来可把「工作区」概念完全下沉，后端退化为纯 LLM 编排。
**缺点**：改造面最大；断连语义复杂；后端与客户端版本必须兼容（协议升级要有版本号）。

### 方案三：混合 + MCP 兼容（演进方向）

- 读与检索留在后端（`rg` 快、无副作用）；写与执行在主进程（需审批）。
- 或把工作区能力实现成 **MCP server（stdio）**，后端作为 MCP client 接入。MCP 规范只定义两种传输：**stdio** 与 **Streamable HTTP**（HTTP+SSE 是 2024-11-05 旧版，已被取代）；工具接口最小面为 `tools/list` 与 `tools/call`，server 必须声明 `tools` capability，列表变化发 `notifications/tools/list_changed`。
- 生态现状：官方 `modelcontextprotocol/servers` 仓库维护 Everything / Fetch / **Filesystem** / Git / Memory / Sequential Thinking / Time，其中 filesystem 有官方参考实现，**shell/terminal 类没有官方参考实现**。
- 收益：将来能直接复用生态的 filesystem server，并让用户接第三方 MCP；成本：多一层进程与协议。

### 推荐路线

| 期                       | 目标                              | 验收标准                                                                                           |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| 一期（方案一，受限形态） | 打通「选目录 → 读 → 改 → 跑测试」 | 在工作区内完成一次「改一个文件并让测试通过」；工作区外路径一律拒绝；命令默认需显式开启且走白名单   |
| 二期（方案二）           | 执行与审批落到主进程              | 写文件与跑命令前必须出现审批卡片；拒绝后模型收到「用户拒绝」而非静默失败；「停止」能杀掉在跑的命令 |
| 三期（可选，方案三）     | MCP 化与生态接入                  | 后端可挂载至少一个外部 MCP server 并列出其工具                                                     |

先做一期。**若已经确定后端不允许碰本机文件，直接做二期**——一期会白写一遍工具实现。

---

## 5. 分领域实现要点

### 5.1 路径与安全边界（一处写错全盘皆输）

- 所有入参路径先 `path.resolve(workspaceRoot, input)` 再校验 `resolved === root || resolved.startsWith(root + path.sep)`；**禁止**用字符串前缀判断（`/tmp/ws-evil` 会骗过 `/tmp/ws`）。
- 解析**符号链接真实路径**后再校验，防软链逃逸。
- Windows 注意盘符大小写与 `\`、`/` 混用；`..` 与 UNC 路径显式拒绝。
- 拒绝写入 `.git/`、`node_modules/`（或按忽略规则统一处理）。

### 5.2 工具设计约定（对齐 backend-design §7）

- 入参用 `zod`，非法入参**抛中文错误**（现有工具风格见 [tools.ts](apps/agent-server/src/llm/tools.ts#L73-L88)）。
- 每个工具的返回必须**自解释且可恢复**：文件被截断要说明、补丁未匹配要给出附近上下文。
- 结果带「来源」标注（现有规范要求），例如 `【文件 src/a.ts 第 12-40 行】`。
- 记录请求级日志（`userId` / `conversationId` / 工具名 / 耗时），复用现有 `Logger` 注入方式。

### 5.3 补丁格式

- 一期只支持 SEARCH/REPLACE，且**同一块 SEARCH 必须唯一匹配**，否则报错并回传附近内容让模型重试。
- 保留 Codex 式「apply_patch 是独立工具」这一点：让模型显式选择「整文件写」还是「局部补丁」，而不是混在一个 `write_file` 里。

### 5.4 审批模型

借鉴 Codex 的正交设计：审批策略（何时问人）× 沙箱模式（能碰到什么）。落到本仓库即：

- 设置项：`workspaceAutoApprove: 'off' | 'read' | 'edit' | 'all'`（默认 `off` 或 `read`）。
- 命令另设 allowlist（如只放 `pnpm test`、`git status`），未命中即问人。
- 审批结果持久化在会话内，避免同一补丁问两次。

### 5.5 命令执行

- `spawn(command, args, { cwd, timeout, killSignal, signal, windowsHide: true })`；Windows 下 shell 差异要用 `shell: true` 或显式 `cmd /c`，并接受由此带来的注入面。
- 输出限长（如 8KB）+ 说明「已截断」；退出码与耗时一并回传。
- 中断必须**杀进程树**（Windows 上 `taskkill /T`），否则子进程会残留。

### 5.6 检查点与回滚

- 影子 git 仓库（Cline 做法）比「自己存全量快照」更省空间且能表述重命名；注意它**独立于项目 Git**，不污染用户仓库。
- 最小可用替代：改动前把原文件内容存入会话表，提供「还原本次会话的全部改动」。

### 5.7 上下文

- 规则文件：优先 `AGENTS.md`（跨工具标准）+ 复用 `.trae/rules/`；注入位置统一在 `llm/prompt.ts`（backend-design §7）。
- repo map 一期用「目录树 + `package.json` / README 摘要 + 改动文件全文」即可，token 预算写进配置。

### 5.8 协议与类型

- 新事件类型一律先加到 `packages/reusable/src/chat.ts`（业务约定绑定的可复用代码归 reusable），再同步两端消费点；注意联合类型是封闭的，客户端 `else` 分支语义要保持与注释一致（此前踩过一次）。

### 5.9 配置与设置项

- 后端：`config.ts` 的 `AppConfig` 加字段 → `loadConfig()` 读 env + 默认值 → 同步 `.env.development` / `.env.production` → 同步 README 配置表；路径类配置用绝对路径。
- 客户端：`preload/types.ts` 加字段与默认值 → 需要主进程即时生效的在 `ipc.ts` 的 `settings:save` 分支处理 → 渲染进程经 `api/bridge.ts` 读取。

### 5.10 界面

- 新增组件按「目录化 + 超 200 行拆分」组织；色值走 CSS 变量；渲染进程不直接引 `@repo/*`（一律经 `api/client.ts` 转发）。

### 5.11 沙箱的现实预期

Node/Electron **没有**跨平台现成沙箱。Codex 的现状可作为预期锚点：macOS 用 Seatbelt，Linux 用 seccomp 或 bubblewrap，**Windows 没有现成机制所以官方自研**（评估后放弃了 AppContainer / Windows Sandbox / MIC）。本仓库一期只做**策略级沙箱**（路径白名单 + 命令 allowlist + 超时 + 无网络参数），不要承诺内核级隔离。

---

## 6. 与既有工程规范的对接（硬约束）

| 规范条文                                                          | 对本方案的要求                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| backend-design §1 依赖方向单向 `routes → services → store/llm/db` | 工作区能力先落 `services/` 或独立领域目录，路由只做校验与调用                                                                          |
| backend-design §2 新增接口标准动作                                | 新路由用 `create<Name>Router(deps)` + `Pick<AppDependencies, ...>`，在 `routes/index.ts` 注册并集中声明鉴权，补 `src/__vitest__/` 用例 |
| backend-design §6 数据层                                          | 新表进 `db/schema.ts` 的 `ensureTables`，`CREATE TABLE IF NOT EXISTS`、utf8mb4、`DATETIME(3)`、参数化查询                              |
| backend-design §7 LLM 与工具                                      | 工具放 `llm/tools.ts`（或同目录拆分），自校验入参、抛中文错误、结果带来源；system prompt 统一在 `llm/prompt.ts`                        |
| backend-design §8 配置                                            | 新配置必须同步 `AppConfig`、`loadConfig`、两份 env、README 配置表；路径类配置绝对路径                                                  |
| desktop-design §2 安全基线                                        | **不得**为工作区能力放开渲染进程 Node；不要打开 `nodeIntegration`                                                                      |
| desktop-design §3 IPC 契约                                        | 通道命名 `域:动作`；增删 IPC 三处同步；只暴露白名单方法，禁止暴露 `ipcRenderer`                                                        |
| desktop-design §4 渲染进程分层                                    | 一律经 `api/bridge.ts`；`api/client.ts` 仍是唯一引 `@repo/*` 的模块                                                                    |
| desktop-design §8 新增设置项清单                                  | 新增 4 步走完，默认值只在 `preload/types.ts` 写一份                                                                                    |
| desktop-design §9 构建打包                                        | 新依赖会被打进 `app.asar`，体积敏感                                                                                                    |
| 总纲 依赖方向                                                     | 新的可复用类型/常量（SSE 事件、状态码）进 `@repo/reusable`；纯工具进 `@repo/shared`；禁止 `apps/*` 互相 import                         |

---

## 7. 风险与未解问题

| 风险                 | 说明                                                                                                                     | 缓解                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Prompt injection** | 工作区文件内容会成为指令来源，诱导执行危险命令                                                                           | 审批闸门 + `deny` 规则优先于一切模式（Claude Code 的顺序值得照抄）+ 命令 allowlist   |
| **模型能力不足**     | 本地 `qwen2.5:7b` 难以稳定产出可解析补丁；仓库已有教训：不支持 function call 的模型（如 `deepseek-r1:7b`）会直接编造答案 | 编码场景必须换支持工具调用且上下文更大的模型；把「模型是否支持工具调用」做成启动校验 |
| 不可逆改动           | 命令可删库、可改系统                                                                                                     | 影子 git 检查点 + 一期不做删除工具 + 默认需审批                                      |
| 上下文膨胀           | 读几个大文件就爆预算                                                                                                     | repo map + 忽略规则 + 读文件必须支持行区间与截断提示                                 |
| 命令残留进程         | 中断后子进程仍在跑                                                                                                       | 杀进程树（Windows `taskkill /T`）                                                    |
| 协议双向化           | 方案二的超时、断连、迟到回执语义复杂                                                                                     | 协议带 `requestId` + 版本号；先写 ADR 再实现                                         |
| 多窗口/多会话        | 同一工作区被两个窗口同时改                                                                                               | 会话级工作区绑定 + 主进程单实例锁（已有）                                            |
| 编码与换行           | CRLF/LF 混用会把整文件 diff 打爆                                                                                         | 读写统一按原文件换行风格回写                                                         |

**未解问题（需要你拍板）**：

1. 后端是否允许接触本机文件系统？（决定一期走方案一还是直接方案二）
2. 工作区是「一次一个」还是「每个会话一个」？
3. 命令执行是否在一期就开放？若开放，默认 allowlist 里放哪些命令？
4. 是否需要 MCP 兼容（影响是否值得按 MCP 的 `tools/list` / `tools/call` 形状设计内部工具接口）？

---

## 8. 建议的落地顺序（工单粒度）

| #   | 工单                                                                       | 依赖 |
| --- | -------------------------------------------------------------------------- | ---- |
| 1   | ADR：工作区归属与执行侧抉择（含方案一的已知妥协）                          | —    |
| 2   | 后端：工作区路径解析与边界校验模块 + 单测（含 `..`、符号链接、前缀陷阱）   | 1    |
| 3   | 后端：只读工具集（`list_files` / `read_file` / `search_in_files`）+ 单测   | 2    |
| 4   | 客户端：`workspace:pick` IPC（三处同步）+ `AppSettings` 字段 + bridge 读取 | 1    |
| 5   | 后端：会话与工作区绑定（schema + 路由 + 用例）                             | 2    |
| 6   | 后端：`write_file` / `apply_patch`（先只支持 SEARCH/REPLACE）              | 3    |
| 7   | 协议：`file_change` 事件 + 两端展示（结构化 diff）                         | 6    |
| 8   | 后端：`run_command`（超时、截断、杀进程树、allowlist）                     | 2    |
| 9   | 二期：审批模型与审批卡片（`approval_request` + 回执接口）                  | 6、8 |
| 10  | 二期：会话级检查点与还原                                                   | 6    |
| 11  | 提示词与规则文件：`AGENTS.md` + repo map 近似实现                          | 3    |
| 12  | 模型切换与「工具调用能力」启动校验                                         | —    |

---

## 9. 参考资料（一手来源）

**Codex（OpenAI）**

- 审批策略与沙箱模式、云端容器离线执行、密钥在 setup 后移除：https://developers.openai.com/codex/agent-approvals-security
- 本地配置（`~/.codex/config.toml`、profiles）：https://developers.openai.com/codex/local-config
- 云端联网开关：https://developers.openai.com/codex/cloud/internet-access ；云端接入与 PR：https://developers.openai.com/codex/cloud
- Windows 沙箱自研与取舍（弃用 AppContainer / Windows Sandbox / MIC）：https://openai.com/index/building-codex-windows-sandbox/
- 源码：`apply_patch` 入口与平台沙箱分支：https://github.com/openai/codex/blob/main/codex-rs/arg0/src/lib.rs
- 未证实项：`AGENTS.md` 的加载优先级（`docs/agents_md.md` 抓取失败）；Codex Cloud environments 逐项说明（需登录）

**Claude Code（Anthropic）**

- 权限模式：https://code.claude.com/docs/en/permission-modes
- 权限规则与评估顺序（hooks → deny → ask → 模式 → allow）：https://code.claude.com/docs/en/permissions
- settings 字段：https://code.claude.com/docs/en/settings-reference#permission-settings
- hooks：https://code.claude.com/docs/en/hooks ；MCP 接入：https://code.claude.com/docs/en/mcp

**MCP（规范原文）**

- 工具接口 `tools/list` / `tools/call` 与「人类在环」要求：https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- 传输（仅 stdio 与 Streamable HTTP）：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- 2024-11-05 版安全要求：https://modelcontextprotocol.io/specification/2024-11-05/server/tools
- 官方参考实现清单（含 filesystem，无 shell）：https://github.com/modelcontextprotocol/servers

**Cline / Roo Code**

- Plan/Act 模式：https://docs.cline.bot/core-workflows/plan-and-act
- Checkpoints（shadow git）：https://docs.cline.bot/core-workflows/checkpoints
- 规则文件：https://docs.cline.bot/features/cline-rules
- Roo auto-approve 分类与风险提示：https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions/ ；Roo checkpoints：https://roocodeinc.github.io/Roo-Code/features/checkpoints/
- 未证实项：Cline「逐处 diff 审批」无官方原文；Roo 独立 Plan/Act 官方页未找到

**Aider**

- repo map 与 `--map-tokens`：https://aider.chat/docs/repomap.html
- 编辑格式官方列表：https://aider.chat/docs/more/edit-formats.html
- git 集成（自动 commit、跳过钩子、Conventional Commits）：https://aider.chat/docs/git.html
- 未证实项：`/undo` 的实现依据

**Node / Electron / ripgrep**

- `child_process.spawn` 选项（`cwd` / `timeout` / `killSignal` / `signal`）：https://nodejs.org/api/child_process.html
- Electron 安全清单（context isolation、process sandbox、CSP、校验 IPC sender）：https://www.electronjs.org/docs/latest/tutorial/security
- `dialog.showOpenDialog`：https://www.electronjs.org/docs/latest/api/dialog
- ripgrep 忽略行为：https://github.com/BurntSushi/ripgrep
- AGENTS.md 开放格式：https://agents.md/
